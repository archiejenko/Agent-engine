import {
  type IdeasConfig,
  type InfraConfig,
  loadIdeasConfig,
  loadSicSectors,
  sectorFor,
} from "@ae/config";
import {
  type CardStatus,
  type Figure,
  type FigureLabel,
  IdeaCard,
  type KillCriterion,
  Signal,
} from "@ae/contracts";
import type { ModelClient } from "@ae/ports";
import type { DecisionOption, Storage } from "@ae/storage";
import { playbookDailyCap, spendTier, weekStart } from "./budget.ts";
import { estimatePaid, sendCostGbp } from "./ev.ts";
import { writeAgentNote } from "./vault.ts";
import type { WorkflowDef, WorkflowPort } from "./workflow.ts";

/**
 * v3 Phase 6 (with v2 Phase 7): scouts → signals → idea cards → Archie → experiments, and the Board.
 *
 * - **Scouts read; they never act.** `scoutSignals` is a pure function with no tools. It turns structured
 *   source records into schema-checked signals. Raw text a scout read never leaves it.
 * - **All maths is code** (rule 4). Every number on a card is a labelled Figure: real, estimated or
 *   assumed. A figure built from others takes the weakest label among them, with their assumptions.
 * - **One decisions queue** (rule 18). Pass / fail / park are decisions; questions and comments are thread
 *   entries, which spend nothing.
 * - Archie's fail reasons go to the decision log (and the seeded hypothesis, if any), never the ledger.
 */

export interface IdeaDeps {
  storage: Storage;
  cfg: InfraConfig;
  icfg?: IdeasConfig;
  model?: ModelClient;
  workflows?: WorkflowPort;
  now?: () => Date;
}
const icfgOf = (d: IdeaDeps) => d.icfg ?? loadIdeasConfig();
const nowOf = (d: IdeaDeps) => d.now?.() ?? new Date();

async function sha(text: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "x";

// ---- Labelled figures

const STRENGTH: Record<FigureLabel, number> = { assumed: 0, estimated: 1, real: 2 };
export const fig = (
  value: number,
  label: FigureLabel,
  assumption: string | null = null,
): Figure => ({
  value: Number.isFinite(value) ? value : 0,
  label,
  assumption: label === "real" ? null : (assumption ?? "stated in config"),
});
/** A figure computed from others: the weakest label wins, and their assumptions are carried. */
export function derived(value: number, parts: Figure[], note?: string): Figure {
  const label = parts.reduce<FigureLabel>(
    (w, p) => (STRENGTH[p.label] < STRENGTH[w] ? p.label : w),
    "real",
  );
  const notes = [...new Set(parts.map((p) => p.assumption).filter((a): a is string => !!a))];
  if (note) notes.unshift(note);
  return fig(value, label, label === "real" ? null : notes.join("; ").slice(0, 300) || null);
}

// ---- Scouts

/** One record a scout read from a public source: structured fields, plus any raw text it saw. */
export interface ScoutRecord {
  source_name: string;
  source_url: string;
  entity_id: string | null;
  signal_type: string;
  value: unknown;
  taxonomy_node: string;
  buyer: string;
  industry: string | null;
  observed_at: string;
  /** Raw page or email text. Untrusted; it never leaves the scout. */
  raw_text?: string;
}

export const marketKeyOf = (field: string, buyer: string, industry: string | null) =>
  `${field}:${slug(industry ?? buyer)}`;

/**
 * Pure: records → signals. A record whose source isn't listed for the field, or whose values don't fit the
 * signal schema (free text, instructions, markup), is rejected. A source whose terms forbid reuse is put
 * in the licensed lane. The scout has no tools and returns nothing but signals.
 */
export async function scoutSignals(
  icfg: IdeasConfig,
  fieldId: string,
  records: ScoutRecord[],
): Promise<{ signals: Signal[]; rejected: { index: number; reason: string }[] }> {
  const field = icfg.fields.find((f) => f.id === fieldId);
  if (!field) throw new Error(`no scouting field ${fieldId}`);
  const signals: Signal[] = [];
  const rejected: { index: number; reason: string }[] = [];
  for (const [index, r] of records.entries()) {
    const source = field.sources.find((s) => s.name === r.source_name);
    if (!source) {
      rejected.push({ index, reason: `${r.source_name} isn't a source for ${fieldId}` });
      continue;
    }
    const candidate = {
      signal_id: `sig-${(
        await sha(
          JSON.stringify([
            fieldId,
            r.source_name,
            r.source_url,
            r.signal_type,
            r.entity_id,
            r.value,
          ]),
        )
      ).slice(0, 20)}`,
      field: fieldId,
      source_name: r.source_name,
      source_url: r.source_url,
      lane: source.reuse_allowed ? source.lane : "licensed",
      entity_id: r.entity_id,
      signal_type: r.signal_type,
      value: r.value,
      taxonomy_node: r.taxonomy_node,
      market: { buyer: r.buyer, industry: r.industry },
      observed_at: r.observed_at,
      untrusted: true,
    };
    const ok = Signal.safeParse(candidate);
    if (!ok.success) {
      rejected.push({
        index,
        reason: ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      continue;
    }
    signals.push(ok.data);
  }
  return { signals, rejected };
}

/** Stores signals and puts each new market on the Board in "scanning". */
export async function storeSignals(
  storage: Storage,
  signals: Signal[],
  o: { synthetic?: boolean } = {},
): Promise<number> {
  let n = 0;
  for (const s of signals) {
    const market_key = marketKeyOf(s.field, s.market.buyer, s.market.industry);
    if (
      await storage.scoutSignals.add({
        signal_id: s.signal_id,
        field: s.field,
        source_name: s.source_name,
        source_url: s.source_url,
        lane: s.lane,
        entity_id: s.entity_id,
        signal_type: s.signal_type,
        value: s.value,
        taxonomy_node: s.taxonomy_node,
        market_key,
        market: s.market,
        observed_at: s.observed_at,
        synthetic: o.synthetic === true,
      })
    )
      n++;
    await storage.board.ensure({
      market_key,
      label: s.market.industry ? `${s.market.buyer} · ${s.market.industry}` : s.market.buyer,
      field: s.field,
      col: "scanning",
      by: "scout",
      synthetic: o.synthetic === true,
    });
  }
  return n;
}

// ---- Cards

export interface CardOverrides {
  first_year_value_gbp?: number;
  budget_gbp?: number;
  sample_size?: number;
  time_cap_days?: number;
  why: string;
}

export interface RaiseInput {
  field: string;
  signal_ids: string[];
  offer: string;
  thesis: string;
  route: "sell_fix" | "sell_intro" | "sell_data";
  playbooks: string[];
  hypothesis_id?: string | null;
  what_changed?: string | null;
  overrides?: CardOverrides | null;
  kill_criteria?: KillCriterion[];
  created_by: string;
  synthetic?: boolean;
}

/** Companies in the market: verified SIC codes whose sector matches the market's industry (real count). */
async function marketSize(storage: Storage, industry: string | null): Promise<number> {
  const rows = (
    await storage.facts.listCurrent({
      field: "sic_codes",
      status: "verified",
      limit: 100_000,
      offset: 0,
    })
  ).rows;
  if (!industry) return new Set(rows.map((r) => r.entity_id)).size;
  const sectors = loadSicSectors();
  const want = slug(industry);
  return new Set(
    rows
      .filter((r) => {
        const codes = Array.isArray(r.value) ? (r.value as string[]) : [String(r.value)];
        const s = sectorFor(codes, sectors);
        return slug(s.key) === want || slug(s.label) === want;
      })
      .map((r) => r.entity_id),
  ).size;
}

/** Real sends in the last 7 days (not synthetic). */
async function weeklySends(storage: Storage, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return (await storage.outcomeLedger.list({ limit: 100_000, event: "sent" })).filter(
    (r) => !r.synthetic && r.observed_at >= since,
  ).length;
}

/** Builds one card version. All numbers are computed here, each labelled. */
export async function buildCard(
  d: IdeaDeps,
  input: RaiseInput,
  version: number,
  parent: number | null,
  cardId: string,
): Promise<IdeaCard> {
  const { storage, cfg } = d;
  const icfg = icfgOf(d);
  const now = nowOf(d);
  const field = icfg.fields.find((f) => f.id === input.field);
  if (!field) throw new Error(`no scouting field ${input.field}`);
  const signals = (
    await Promise.all(input.signal_ids.map((id) => storage.scoutSignals.get(id)))
  ).filter((s): s is NonNullable<typeof s> => !!s);
  if (!signals.length) throw new Error("a card needs at least one stored signal");
  const first = signals[0] as (typeof signals)[number];
  const market = first.market;
  const ov = input.overrides ?? null;
  const ovNote = ov ? `planner revision: ${ov.why}` : null;

  // Evidence: the signals, plus the verified facts of the companies they're about.
  const entities = [...new Set(signals.map((s) => s.entity_id).filter((e): e is string => !!e))];
  const factIds: string[] = [];
  for (const e of entities.slice(0, 10))
    for (const f of (
      await storage.facts.listCurrent({ entityId: e, status: "verified", limit: 5, offset: 0 })
    ).rows)
      factIds.push(`${f.entity_id}:${f.field}`);

  // Conversion: the ledger estimate (prior until real sends exist).
  const playbook = input.playbooks[0] as string;
  const est = await estimatePaid(storage, cfg, playbook, now.toISOString());
  const paidLabel: FigureLabel = est.basis === "prior" ? "assumed" : "estimated";
  const p_paid = fig(est.p_paid, paidLabel, est.assumptions.join("; "));
  const cost_per_send = fig(sendCostGbp(cfg, "email"), "assumed", "email send cost from config");
  const sends_needed = derived(est.p_paid > 0 ? 1 / est.p_paid : 0, [p_paid], "1 ÷ P(paid)");
  const cac = derived(sends_needed.value * cost_per_send.value, [sends_needed, cost_per_send]);

  // Cost to serve one customer for a year.
  const cm = icfg.cost_model;
  const model = fig(cm.model_gbp_per_customer, "assumed", "model cost per customer (config)");
  const hosting = fig(
    cm.hosting_gbp_per_customer_year,
    "assumed",
    "hosting per customer-year (config)",
  );
  const third = fig(
    cm.third_party_gbp_per_customer_year,
    "assumed",
    "third-party fees per customer-year (config)",
  );
  const minutes = fig(
    cm.owner_minutes_per_customer,
    "assumed",
    "Archie's minutes per customer (config)",
  );
  const rate = fig(
    cfg.owner.hourly_gbp,
    cfg.owner.hourly_is_assumption ? "assumed" : "real",
    "OWNER_HOURLY_GBP placeholder",
  );
  const owner_cost = derived((minutes.value / 60) * rate.value, [minutes, rate]);
  const serve = derived(model.value + hosting.value + third.value + owner_cost.value, [
    model,
    hosting,
    third,
    owner_cost,
  ]);

  const fyv =
    ov?.first_year_value_gbp !== undefined
      ? fig(ov.first_year_value_gbp, "estimated", ovNote)
      : fig(
          cfg.measurement.priors.first_year_value_gbp,
          "assumed",
          "first-year value prior (config)",
        );
  const monthlyMargin = (fyv.value - serve.value) / 12;
  const payback = derived(
    monthlyMargin > 0 ? cac.value / monthlyMargin : 999,
    [cac, fyv, serve],
    "months for one customer's margin to repay what it cost to win",
  );
  const size = fig(await marketSize(storage, market.industry), "real");

  // The test.
  const td = icfg.test_defaults;
  const sample = ov?.sample_size ?? td.sample_size;
  const cap = ov?.time_cap_days ?? td.time_cap_days;
  const budget =
    ov?.budget_gbp !== undefined
      ? fig(ov.budget_gbp, "estimated", ovNote)
      : fig(td.budget_gbp, "assumed", "default test budget (config)");
  const realWeekly = await weeklySends(storage, now);
  const weekly =
    realWeekly > 0
      ? fig(realWeekly, "real")
      : fig(
          icfg.weekly_send_capacity_assumed,
          "assumed",
          "no real sends yet: assumed weekly capacity",
        );
  const reachable = (weekly.value * cap) / 7 >= sample;
  const daysToFirst = derived(
    weekly.value > 0 ? Math.ceil(sends_needed.value / (weekly.value / 7)) : 999,
    [sends_needed, weekly],
    "days to make the sends one sale needs",
  );

  // Expected profit of the test, and Archie's hours for it.
  const customers = sample * p_paid.value;
  const expected_profit = derived(
    customers * (fyv.value - serve.value) - budget.value,
    [p_paid, fyv, serve, budget],
    `${sample} sends × P(paid) × (first-year value − cost to serve) − test budget`,
  );
  const reviewMinutesPerSend = 1;
  const owner_hours = derived(
    (sample * reviewMinutesPerSend + customers * minutes.value) / 60,
    [minutes, p_paid],
    `${reviewMinutesPerSend} review minute per send (assumed) plus minutes per customer`,
  );
  const pph = derived(owner_hours.value > 0 ? expected_profit.value / owner_hours.value : 0, [
    expected_profit,
    owner_hours,
  ]);

  return IdeaCard.parse({
    card_id: cardId,
    version,
    parent_version: parent,
    hypothesis_id: input.hypothesis_id ?? null,
    field: field.id,
    market: { key: first.market_key, buyer: market.buyer, industry: market.industry },
    offer: input.offer,
    thesis: input.thesis,
    taxonomy_node: first.taxonomy_node,
    route: input.route,
    lane: signals.some((s) => s.lane === "licensed") ? "licensed" : "open",
    regulated: field.regulated,
    legal_check: null,
    evidence: { fact_ids: factIds, signal_ids: signals.map((s) => s.signal_id), vault_notes: [] },
    economics: {
      cost_to_serve: {
        total: serve,
        model,
        hosting,
        third_party: third,
        owner_minutes: minutes,
        owner_cost,
      },
      cost_to_acquire: { total: cac, sends_needed, cost_per_send, p_paid },
      first_year_value: fyv,
      payback_months: payback,
      market_size_companies: size,
      expected_profit,
      owner_hours,
      profit_per_owner_hour: pph,
    },
    test: {
      budget_gbp: budget,
      sample_size: sample,
      time_cap_days: cap,
      weekly_volume: weekly,
      reachable,
      days_to_first_gbp: daysToFirst,
    },
    kill_criteria: input.kill_criteria ?? icfg.default_kill_criteria,
    success_criteria: `No kill criterion trips within ${cap} days`,
    next_budget_step_gbp: td.next_budget_step_gbp,
    playbooks: input.playbooks,
    what_changed: input.what_changed ?? null,
    overrides: ov,
    created_by: input.created_by,
    created_at: now.toISOString(),
  });
}

/** The content of a card that matters for "is this the same idea again". */
export const cardFingerprint = (c: IdeaCard) =>
  sha(
    JSON.stringify([
      c.market.key,
      c.offer.trim().toLowerCase(),
      c.route,
      c.test.sample_size,
      c.test.budget_gbp.value,
      c.test.time_cap_days,
      c.economics.first_year_value.value,
      c.kill_criteria,
    ]),
  );

const cardRef = (id: string, v: number) => `card:${id}@${v}`;
export const parseCardRef = (ref: string) => {
  const m = /^card:(.+)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`not a card ref: ${ref}`);
  return { card_id: m[1] as string, version: Number(m[2]) };
};

/** Pass is only offered once a regulated introduction card has its legal check. */
export const needsLegalCheck = (c: IdeaCard) =>
  c.route === "sell_intro" && c.regulated && c.legal_check === null;

async function openIdeaDecision(d: IdeaDeps, c: IdeaCard, synthetic: boolean) {
  const options: DecisionOption[] = [
    ...(needsLegalCheck(c)
      ? []
      : [
          {
            key: "pass",
            label: "Pass",
            effect: "Queue the test (starts by itself if it fits the limits)",
          },
        ]),
    {
      key: "fail",
      label: "Fail",
      effect: "Drop it; your reason is kept so it isn't raised again unchanged",
    },
    { key: "park", label: "Park", effect: "Leave it for now; nothing is spent" },
  ];
  const hours = 168;
  await d.storage.decisions.open({
    type: "idea",
    source_ref: cardRef(c.card_id, c.version),
    summary: `Idea: ${c.offer} (${c.market.buyer}${c.market.industry ? `, ${c.market.industry}` : ""})`,
    money_at_stake_gbp: c.economics.expected_profit.value,
    money_kind: c.economics.expected_profit.label,
    options,
    recommended: needsLegalCheck(c)
      ? "park"
      : c.economics.expected_profit.value > 0
        ? "pass"
        : "park",
    safe_default: "park",
    deadline: new Date(nowOf(d).getTime() + hours * 3_600_000).toISOString(),
    context: { card_id: c.card_id, version: c.version, legal_check_needed: needsLegalCheck(c) },
    synthetic,
  });
}

/** Stores a card version: checks, status, Board tile, and (if proposed) its decision. */
async function storeCard(d: IdeaDeps, c: IdeaCard, synthetic: boolean, _prior: IdeaCard | null) {
  const { storage } = d;
  let status: CardStatus = "proposed";
  let reason: string | null = null;

  // Re-raise: a failed or killed idea comes back only with what changed, and must actually differ from
  // the version that was failed (not merely from a blocked attempt since).
  const failedBefore = (await storage.ideaCards.versions(c.card_id))
    .filter((v) => ["failed", "killed"].includes(v.status))
    .at(-1);
  const hyp = c.hypothesis_id ? await storage.hypotheses.get(c.hypothesis_id) : null;
  if (failedBefore || hyp?.decision === "Fail") {
    const same = failedBefore
      ? (await cardFingerprint(failedBefore.card as IdeaCard)) === (await cardFingerprint(c))
      : false;
    if (!c.what_changed || same) {
      status = "blocked_reraise";
      reason = !c.what_changed
        ? "this idea was failed before; a re-raise must say what is different"
        : "this idea was failed before and nothing on the card has changed";
    }
  }
  // Volume check: can it reach its sample size inside its time cap?
  if (status === "proposed" && !c.test.reachable) {
    status = "rejected_underpowered";
    reason = `${c.test.weekly_volume.value} sends a week can't reach ${c.test.sample_size} in ${c.test.time_cap_days} days`;
  }
  await storage.ideaCards.add({
    card_id: c.card_id,
    version: c.version,
    hypothesis_id: c.hypothesis_id,
    market_key: c.market.key,
    card: c,
    status,
    status_reason: reason,
    rank_value: c.economics.profit_per_owner_hour.value,
    synthetic,
  });
  if (status === "proposed") {
    await storage.board.move(
      c.market.key,
      "proposed",
      "planner",
      `card ${c.card_id} v${c.version} raised`,
    );
    await openIdeaDecision(d, c, synthetic);
  }
  return { card: c, status, reason };
}

/**
 * The planner raises a card from signals. Idempotent: a card that's already live is returned as is. A
 * failed or killed card can only come back as a new version that states what changed and differs.
 */
export async function raiseCard(d: IdeaDeps, input: RaiseInput) {
  const first = await d.storage.scoutSignals.get(input.signal_ids[0] ?? "");
  if (!first) throw new Error("a card needs at least one stored signal");
  await d.storage.board.move(first.market_key, "researching", "planner", "building a card");
  const cardId = `card-${slug(first.market_key).slice(0, 30)}-${(
    await sha(`${first.market_key}|${input.offer.trim().toLowerCase()}|${input.route}`)
  ).slice(0, 8)}`;
  const latest = await d.storage.ideaCards.latest(cardId);
  if (
    latest &&
    !["failed", "killed", "blocked_reraise", "rejected_underpowered"].includes(latest.status)
  )
    return {
      card: latest.card as IdeaCard,
      status: latest.status as CardStatus,
      reason: latest.status_reason,
    };
  const card = await buildCard(
    d,
    input,
    (latest?.version ?? 0) + 1,
    latest?.version ?? null,
    cardId,
  );
  return storeCard(d, card, input.synthetic === true, latest ? (latest.card as IdeaCard) : null);
}

/** The inputs a card was built from, so a revision can rebuild it with overrides. */
const inputOf = (c: IdeaCard, overrides: CardOverrides | null): RaiseInput => ({
  field: c.field,
  signal_ids: c.evidence.signal_ids,
  offer: c.offer,
  thesis: c.thesis,
  route: c.route,
  playbooks: c.playbooks,
  hypothesis_id: c.hypothesis_id,
  what_changed: c.what_changed,
  overrides,
  kill_criteria: c.kill_criteria,
  created_by: "planner",
});

/** Supersedes a version (and its open decision) when a newer one replaces it. */
async function supersede(d: IdeaDeps, c: IdeaCard) {
  await d.storage.ideaCards.setStatus(
    c.card_id,
    c.version,
    "superseded",
    `replaced by v${c.version + 1}`,
  );
  const open = await d.storage.decisions.openFor("idea", cardRef(c.card_id, c.version));
  if (open)
    await d.storage.decisions.close(open.id, {
      status: "superseded",
      chosen_option: null,
      decided_by: "system",
    });
}

// ---- Thread: questions (answered by the planner, with evidence), comments, legal check

const REVISABLE = ["first_year_value_gbp", "budget_gbp", "sample_size", "time_cap_days"] as const;
interface PlannerAnswer {
  answer: string;
  evidence: string[];
  revise?: { key: (typeof REVISABLE)[number]; value: number; why: string } | null;
}

/**
 * Archie asks a question. The planner answers from the card (structured data only; no raw fetched
 * content ever reaches it) and must cite evidence that is on the card; an answer without it is refused.
 * If it revises an assumption, the card gets a new version (the old one is superseded).
 */
export async function askQuestion(d: IdeaDeps, cardId: string, question: string, by: string) {
  const { storage } = d;
  const row = await storage.ideaCards.latest(cardId);
  if (!row) throw new Error("no such card");
  const c = row.card as IdeaCard;
  await storage.ideaThread.add({
    card_id: cardId,
    version: c.version,
    kind: "question",
    author: by,
    text: question,
    evidence: [],
  });
  if (!d.model) throw new Error("no planner model");
  const res = await d.model.complete({
    prompt_id: "idea_answer",
    prompt_version: 1,
    role: "planner",
    system:
      "You answer Archie's question about one idea card. Use only the card. Cite the evidence ids you rely on (fact ids or signal ids from the card). If the question shows an assumption should change, propose one revision of first_year_value_gbp, budget_gbp, sample_size or time_cap_days. Reply as JSON.",
    user: JSON.stringify({ card: c, question }),
    json_schema: {
      type: "object",
      properties: {
        answer: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        revise: { type: ["object", "null"] },
      },
      required: ["answer", "evidence"],
    },
    max_tokens: 800,
  });
  let a: PlannerAnswer | null = null;
  try {
    a = JSON.parse(res.text) as PlannerAnswer;
  } catch {
    a = null;
  }
  const onCard = new Set([...c.evidence.fact_ids, ...c.evidence.signal_ids]);
  const cited = (a?.evidence ?? []).filter((e) => onCard.has(e));
  if (!a || typeof a.answer !== "string" || cited.length === 0) {
    await storage.ideaThread.add({
      card_id: cardId,
      version: c.version,
      kind: "answer",
      author: "planner",
      text: "I couldn't answer that from the card's evidence, so I've made no change.",
      evidence: [],
    });
    return { answered: false, version: c.version };
  }
  await storage.ideaThread.add({
    card_id: cardId,
    version: c.version,
    kind: "answer",
    author: "planner",
    text: a.answer.slice(0, 2000),
    evidence: cited,
  });
  const rv = a.revise;
  if (!rv || !REVISABLE.includes(rv.key) || !Number.isFinite(rv.value) || rv.value <= 0)
    return { answered: true, version: c.version };
  const prior = c.overrides ?? null;
  const overrides: CardOverrides = {
    ...(prior ?? {}),
    [rv.key]: rv.value,
    why: String(rv.why).slice(0, 200),
  };
  const next = IdeaCard.parse({
    ...(await buildCard(d, inputOf(c, overrides), c.version + 1, c.version, cardId)),
    legal_check: c.legal_check,
  });
  await supersede(d, c);
  const stored = await storeCard(d, next, row.synthetic, null);
  await storage.ideaThread.add({
    card_id: cardId,
    version: next.version,
    kind: "revision",
    author: "planner",
    text: `v${next.version}: ${rv.key} → ${rv.value} (${overrides.why})`,
    evidence: cited,
  });
  return { answered: true, version: next.version, status: stored.status };
}

export async function addComment(d: IdeaDeps, cardId: string, text: string, by: string) {
  const row = await d.storage.ideaCards.latest(cardId);
  if (!row) throw new Error("no such card");
  await d.storage.ideaThread.add({
    card_id: cardId,
    version: row.version,
    kind: "comment",
    author: by,
    text,
    evidence: [],
  });
}

/** Archie completes the legal check on a regulated introduction card: a new version that may be passed. */
export async function completeLegalCheck(d: IdeaDeps, cardId: string, note: string, by: string) {
  const row = await d.storage.ideaCards.latest(cardId);
  if (!row) throw new Error("no such card");
  const c = row.card as IdeaCard;
  const next = IdeaCard.parse({
    ...c,
    version: c.version + 1,
    parent_version: c.version,
    legal_check: { by, note, at: nowOf(d).toISOString() },
    created_at: nowOf(d).toISOString(),
  });
  await supersede(d, c);
  await d.storage.ideaThread.add({
    card_id: cardId,
    version: next.version,
    kind: "revision",
    author: by,
    text: `Legal check: ${note}`,
    evidence: [],
  });
  return storeCard(d, next, row.synthetic, null);
}

// ---- Feed decisions (applied from decide(); never called by a route directly)

export async function applyIdeaOption(
  d: IdeaDeps,
  ref: string,
  option: string,
  o: {
    approvalId: string | null;
    reason?: string | null;
    by: string;
    defaulted: boolean;
    decisionId: string;
  },
) {
  const { storage } = d;
  const { card_id, version } = parseCardRef(ref);
  const row = await storage.ideaCards.get(card_id, version);
  if (!row) throw new Error("no such card");
  const c = row.card as IdeaCard;
  if (option === "park") {
    await storage.ideaCards.setStatus(
      card_id,
      version,
      "parked",
      o.defaulted ? "defaulted" : "parked by Archie",
    );
    return;
  }
  if (option === "fail") {
    const reason = (o.reason ?? "").trim() || "no reason given";
    await storage.ideaCards.setStatus(card_id, version, "failed", reason);
    // Archie's reason: the decision log (read by the planner), never the outcome ledger.
    await storage.decisionLog.add({
      id: crypto.randomUUID(),
      at: nowOf(d).toISOString(),
      subject: "idea",
      subject_id: card_id,
      graph_id: null,
      graph_version: null,
      decision: "reject",
      reason,
      by: o.by,
      decision_id: o.decisionId,
    });
    if (c.hypothesis_id) {
      const { applyIdeaDecision } = await import("./ideas.ts");
      await applyIdeaDecision(storage, c.hypothesis_id, "Fail", o.by, reason);
    }
    await storage.ideaThread.add({
      card_id,
      version,
      kind: "comment",
      author: o.by,
      text: `Failed: ${reason}`,
      evidence: [],
    });
    const live = (await storage.ideaCards.forMarket(c.market.key)).some((x) =>
      ["proposed", "passed", "budget_pending", "testing"].includes(x.status),
    );
    if (!live)
      await storage.board.move(c.market.key, "researching", "planner", "its only idea was failed");
    return;
  }
  if (option === "pass") {
    if (needsLegalCheck(c))
      throw new Error("a regulated introduction card needs its legal check first");
    await storage.ideaCards.setStatus(card_id, version, "passed", null);
    const why = await autoStartBlocked(d, c);
    if (!why) return startExperiment(d, c, o.approvalId, row.synthetic);
    await storage.ideaCards.setStatus(card_id, version, "budget_pending", why);
    await storage.decisions.open({
      type: "idea_budget",
      source_ref: ref,
      summary: `Budget for the test of "${c.offer}": £${c.test.budget_gbp.value.toFixed(2)}`,
      money_at_stake_gbp: c.test.budget_gbp.value,
      money_kind: c.test.budget_gbp.label,
      options: [
        {
          key: "approve_budget",
          label: "Approve the budget",
          effect: `Start the test (£${c.test.budget_gbp.value.toFixed(2)} cap)`,
        },
        { key: "keep_parked", label: "Keep parked", effect: "Nothing is spent" },
      ],
      recommended: "keep_parked",
      safe_default: "keep_parked",
      deadline: new Date(nowOf(d).getTime() + 72 * 3_600_000).toISOString(),
      context: { card_id, version, why },
      synthetic: row.synthetic,
    });
  }
}

export async function applyIdeaBudgetOption(
  d: IdeaDeps,
  ref: string,
  option: string,
  o: { approvalId: string | null; defaulted: boolean },
) {
  const { card_id, version } = parseCardRef(ref);
  const row = await d.storage.ideaCards.get(card_id, version);
  if (!row) throw new Error("no such card");
  if (option === "approve_budget")
    return startExperiment(d, row.card as IdeaCard, o.approvalId, row.synthetic);
  await d.storage.ideaCards.setStatus(
    card_id,
    version,
    "parked",
    o.defaulted ? "defaulted" : "kept parked",
  );
}

/** v3 decision D3: a passed test starts by itself only if every condition holds; otherwise, why not. */
export async function autoStartBlocked(d: IdeaDeps, c: IdeaCard): Promise<string | null> {
  const { storage, cfg } = d;
  const icfg = icfgOf(d);
  const budget = c.test.budget_gbp.value;
  if (budget > icfg.auto_start_test_gbp)
    return `its budget (£${budget.toFixed(2)}) is over the auto-start limit (£${icfg.auto_start_test_gbp.toFixed(2)})`;
  const week = weekStart(nowOf(d));
  const used = (await storage.experiments.running())
    .concat()
    .filter((e) => e.started_at >= week)
    .reduce((a, e) => a + e.budget_gbp, 0);
  const explore = cfg.caps.global_per_day_gbp * 7 * cfg.caps.explore_share;
  if (used + budget > explore + 1e-9)
    return `it doesn't fit this week's explore share (£${(explore - used).toFixed(2)} left)`;
  const pb = c.playbooks[0] as string;
  const tierCap = playbookDailyCap(cfg, pb, await spendTier(storage, pb)) * c.test.time_cap_days;
  if (budget > tierCap) return `it's over ${pb}'s spend tier for ${c.test.time_cap_days} days`;
  if (!c.kill_criteria.length || !c.test.sample_size)
    return "it has no kill criteria or sample size";
  // Concurrency: weekly sends ÷ the smallest sample size in play, so tests don't starve each other.
  const running = await storage.experiments.running();
  const samples = [c.test.sample_size];
  for (const e of running) {
    const r = await storage.ideaCards.get(e.card_id, e.version);
    if (r) samples.push((r.card as IdeaCard).test.sample_size);
  }
  const slots = Math.max(1, Math.floor(c.test.weekly_volume.value / Math.min(...samples)));
  if (running.length >= slots) return `send volume is full (${running.length} tests running)`;
  return null;
}

// ---- Experiments

export const EXPERIMENT_WORKFLOW = "experiment";

export async function startExperiment(
  d: IdeaDeps,
  c: IdeaCard,
  approvalId: string | null,
  synthetic: boolean,
) {
  const id = `exp-${(await sha(`${c.card_id}@${c.version}`)).slice(0, 16)}`;
  if (await d.storage.experiments.get(id)) return id;
  await d.storage.experiments.add({
    id,
    card_id: c.card_id,
    version: c.version,
    hypothesis_id: c.hypothesis_id,
    market_key: c.market.key,
    status: "running",
    budget_gbp: c.test.budget_gbp.value,
    instance_id: `wf-${id}`,
    approval_id: approvalId,
    synthetic,
    started_at: nowOf(d).toISOString(),
  });
  await d.storage.ideaCards.setStatus(c.card_id, c.version, "testing", null);
  await d.storage.board.move(c.market.key, "testing", "experiment", `test ${id} started`);
  if (d.workflows)
    await d.workflows.start(
      EXPERIMENT_WORKFLOW,
      { experiment_id: id },
      { id: `wf-${id}`, synthetic },
    );
  return id;
}

/** The experiment's own funnel, from the outcome ledger (its synthetic flag must match the experiment's). */
export async function experimentMetrics(
  storage: Storage,
  exp: { id: string; synthetic: boolean; spent_gbp: number },
) {
  const rows = (await storage.outcomeLedger.list({ limit: 100_000 })).filter(
    (r) => r.experiment_id === exp.id && r.synthetic === exp.synthetic,
  );
  const count = (ev: string) =>
    new Set(rows.filter((r) => r.event === ev).map((r) => r.task_id ?? r.entity_id)).size;
  const sends = count("sent");
  const per100 = (n: number) => (sends > 0 ? (n * 100) / sends : 0);
  return {
    sends,
    demo_visits_per_100_sends: per100(count("demo_visit")),
    replies_per_100_sends: per100(count("reply")),
    paid_per_100_sends: per100(count("paid")),
    spend_gbp: exp.spent_gbp,
    ledger_rows: rows.map((r) => r.id).filter((x): x is number => typeof x === "number"),
  };
}

/** One daily check: a tripped kill criterion ends the test, writes its post-mortem and moves the tile. */
export async function checkExperiment(
  d: IdeaDeps,
  id: string,
  day: number,
): Promise<{ ended: boolean; tripped: string | null }> {
  const { storage } = d;
  const exp = await storage.experiments.get(id);
  if (exp?.status !== "running") return { ended: true, tripped: null };
  const row = await storage.ideaCards.get(exp.card_id, exp.version);
  const c = row?.card as IdeaCard;
  const m = await experimentMetrics(storage, exp);
  for (const k of c.kill_criteria) {
    if (day < k.by_day) continue;
    if (k.metric !== "spend_gbp" && m.sends === 0) continue; // a rate needs sends to mean anything
    const v = m[k.metric];
    const trips = k.op === "<" ? v < k.threshold : v >= k.threshold;
    if (!trips) continue;
    const tripped = `${k.metric} ${v.toFixed(2)} ${k.op} ${k.threshold} on day ${day}`;
    await endExperiment(d, exp.id, "killed", tripped, c, m, day);
    return { ended: true, tripped };
  }
  if (day >= c.test.time_cap_days) {
    await endExperiment(d, exp.id, "succeeded", null, c, m, day);
    return { ended: true, tripped: null };
  }
  return { ended: false, tripped: null };
}

async function endExperiment(
  d: IdeaDeps,
  id: string,
  status: "killed" | "succeeded",
  tripped: string | null,
  c: IdeaCard,
  m: Awaited<ReturnType<typeof experimentMetrics>>,
  day: number,
) {
  const { storage } = d;
  const exp = await storage.experiments.get(id);
  if (!exp) return;
  const path = `brain/experiments/${id}.md`;
  const body = [
    "---",
    `type: post-mortem`,
    `experiment: ${id}`,
    `card: ${c.card_id}@${c.version}`,
    `result: ${status}`,
    `synthetic: ${exp.synthetic}`,
    "---",
    "",
    `# ${status === "killed" ? "Killed" : "Succeeded"}: ${c.offer}`,
    "",
    `- Market: ${c.market.buyer}${c.market.industry ? `, ${c.market.industry}` : ""}`,
    `- Ran ${day} of ${c.test.time_cap_days} days; budget £${exp.budget_gbp.toFixed(2)}, spent £${exp.spent_gbp.toFixed(2)}`,
    `- Sends ${m.sends}; demo visits per 100 sends ${m.demo_visits_per_100_sends.toFixed(1)}; replies per 100 ${m.replies_per_100_sends.toFixed(1)}; paid per 100 ${m.paid_per_100_sends.toFixed(1)}`,
    tripped
      ? `- Kill criterion tripped: ${tripped}`
      : "- No kill criterion tripped inside the time cap",
    exp.synthetic
      ? "- SYNTHETIC: simulated sends against fixture outcomes. Nothing here is evidence of demand."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  await writeAgentNote(storage, {
    path,
    body,
    agent: "experiment",
    sources: [`card:${c.card_id}@${c.version}`, `experiment:${id}`],
    ledger_rows: m.ledger_rows,
    ...(exp.synthetic ? { labels: ["synthetic" as const] } : {}),
  });
  await storage.experiments.update(id, {
    status,
    kill_reason: tripped,
    postmortem_path: path,
    ended_at: nowOf(d).toISOString(),
  });
  await storage.ideaCards.setStatus(c.card_id, c.version, status, tripped);
  await storage.board.move(
    c.market.key,
    status === "killed" ? "killed" : "live",
    "experiment",
    tripped ?? "test succeeded",
  );
  if (status === "succeeded")
    await storage.decisions.open({
      type: "idea_budget",
      source_ref: `card:${c.card_id}@${c.version}`,
      summary: `Next budget step for "${c.offer}": £${c.next_budget_step_gbp.toFixed(2)}`,
      money_at_stake_gbp: c.next_budget_step_gbp,
      money_kind: "assumed",
      options: [
        { key: "approve_budget", label: "Approve the next step", effect: "Start the larger test" },
        { key: "keep_parked", label: "Stop here", effect: "Nothing more is spent" },
      ],
      recommended: "keep_parked",
      safe_default: "keep_parked",
      deadline: new Date(nowOf(d).getTime() + 72 * 3_600_000).toISOString(),
      context: { card_id: c.card_id, version: c.version, experiment: id },
      synthetic: exp.synthetic,
    });
}

/** The experiment Workflow: a daily kill-criteria check until it trips or the time cap ends it. */
export function experimentWorkflow(d: IdeaDeps): WorkflowDef<{ experiment_id: string }, unknown> {
  return {
    name: EXPERIMENT_WORKFLOW,
    playbook: "experiment",
    run: async (p, step) => {
      const exp = await step.do("load", async () => {
        const e = await d.storage.experiments.get(p.experiment_id);
        const r = e ? await d.storage.ideaCards.get(e.card_id, e.version) : null;
        return { days: (r?.card as IdeaCard | undefined)?.test.time_cap_days ?? 0 };
      });
      for (let day = 1; day <= exp.days; day++) {
        await step.sleep(`day ${day}`, 86_400_000);
        const r = await step.do(`check day ${day}`, () => checkExperiment(d, p.experiment_id, day));
        if (r.ended) return r;
      }
      return { ended: true, tripped: null };
    },
  };
}

// ---- The Board

/** Every tile with its signals, cards, and money spent and earned (synthetic shown separately). */
export async function boardView(storage: Storage) {
  const tiles = await storage.board.list();
  const ledger = await storage.outcomeLedger.list({ limit: 100_000, event: "paid" });
  return Promise.all(
    tiles.map(async (t) => {
      const signals = await storage.scoutSignals.forMarket(t.market_key, 20);
      const cards = (await storage.ideaCards.forMarket(t.market_key)).filter(
        (c) => c.status !== "superseded",
      );
      const exps = await storage.experiments.forMarket(t.market_key);
      const ids = new Set(exps.map((e) => e.id));
      const earned = (synthetic: boolean) =>
        ledger
          .filter((r) => r.experiment_id && ids.has(r.experiment_id) && r.synthetic === synthetic)
          .reduce((a, r) => a + (r.value_gbp ?? 0), 0);
      return {
        ...t,
        signals: signals.map((s) => ({
          id: s.signal_id,
          type: s.signal_type,
          value: s.value,
          source: s.source_name,
        })),
        cards: cards.map((c) => ({
          id: c.card_id,
          version: c.version,
          status: c.status,
          offer: (c.card as IdeaCard).offer,
        })),
        spent_gbp: exps.filter((e) => !e.synthetic).reduce((a, e) => a + e.spent_gbp, 0),
        spent_synthetic_gbp: exps.filter((e) => e.synthetic).reduce((a, e) => a + e.spent_gbp, 0),
        earned_gbp: earned(false),
        earned_synthetic_gbp: earned(true),
        moves: await storage.board.moves(t.market_key),
      };
    }),
  );
}

/** Archie pins, unpins or kills a tile (applied from decide(), recorded as an owner approval). */
export async function applyBoardOption(d: IdeaDeps, ref: string, option: string, by: string) {
  const key = ref.slice("board:".length);
  if (option === "pin" || option === "unpin")
    return d.storage.board.setPinned(key, option === "pin", by);
  if (option === "kill") {
    await d.storage.board.move(key, "killed", by, "killed by Archie");
    for (const e of await d.storage.experiments.forMarket(key))
      if (e.status === "running") {
        await d.storage.experiments.update(e.id, {
          status: "killed",
          kill_reason: "Archie killed the market",
          ended_at: nowOf(d).toISOString(),
        });
        await d.storage.ideaCards.setStatus(
          e.card_id,
          e.version,
          "killed",
          "Archie killed the market",
        );
      }
  }
}

/** The feed: proposed cards and those waiting on a budget, ranked by expected profit per hour of Archie's time. */
export async function ideaFeed(storage: Storage, o: { function?: string; market?: string } = {}) {
  const rows = await storage.ideaCards.list({
    status: ["proposed", "budget_pending", "testing", "parked"],
  });
  return rows
    .map((r) => ({ ...r, card: r.card as IdeaCard }))
    .filter((r) => !o.function || r.card.taxonomy_node === o.function)
    .filter((r) => !o.market || r.market_key === o.market)
    .sort((a, b) => b.rank_value - a.rank_value);
}

/**
 * The deterministic stand-in for the planner's answer (until the real model is switched on). It cites the
 * card's own evidence and proposes a revision only when the question names an assumption and a number.
 */
export function fakeIdeaAnswerer(req: { user: string }): string {
  const { card, question } = JSON.parse(req.user) as { card: IdeaCard; question: string };
  const evidence = [card.evidence.signal_ids[0], card.evidence.fact_ids[0]].filter(
    (e): e is string => !!e,
  );
  const n = Number(/£?\s*(\d+(?:\.\d+)?)/.exec(question)?.[1] ?? Number.NaN);
  const q = question.toLowerCase();
  const key = /first[- ]year|worth|value/.test(q)
    ? "first_year_value_gbp"
    : /budget/.test(q)
      ? "budget_gbp"
      : /sample/.test(q)
        ? "sample_size"
        : /days|time cap/.test(q)
          ? "time_cap_days"
          : null;
  const e = card.economics;
  const answer = `The card rests on ${card.evidence.signal_ids.length} signal(s) and ${card.evidence.fact_ids.length} verified fact(s) about ${card.market.buyer}. Expected profit is £${e.expected_profit.value.toFixed(2)} (${e.expected_profit.label}); first-year value £${e.first_year_value.value.toFixed(2)} (${e.first_year_value.label}).`;
  return JSON.stringify({
    answer,
    evidence,
    revise:
      key && Number.isFinite(n) && n > 0
        ? {
            key,
            value: key === "sample_size" || key === "time_cap_days" ? Math.round(n) : n,
            why: `Archie asked: ${question.slice(0, 120)}`,
          }
        : null,
  });
}
