import type { IdeaCard, PanelFigure, PanelRow, PanelStage, ValueKind } from "@ae/contracts";
import { boardView, CRM_STAGES, crmList, type GitNote, planStatusFor, vaultNotes } from "@ae/infra";
import type { Storage } from "@ae/storage";

/**
 * Panel queries for the pages beyond Home (cockpit UI plan §4, U3). Same rules as panels.ts: read-only,
 * built on existing functions and tables, every number computed here (rule 4), and every result goes
 * through toPanelResult (holdout blind, simulated rows only on request, no secrets, money in pennies).
 */
export interface PageCtx {
  storage: Storage;
  from: string;
  to: string;
  now: Date;
  includeSynthetic: boolean;
  playbook: string | null;
  args: Record<string, string>;
  vault: () => Promise<GitNote[]>;
}

type Out = {
  kind: "rows" | "stages";
  rows?: PanelRow[];
  stages?: PanelStage[];
  meta?: Record<string, number | string | null>;
  value_kind?: ValueKind;
  note: string | null;
  empty: string;
};

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const share = (n: number, top: number) => (top > 0 ? round4(n / top) : 0);

/** Columns as funnel-style stages: count, value and bar length, all from here. */
function columns(
  keys: readonly string[],
  labels: Record<string, string>,
  rows: PanelRow[],
  unit: string,
  kind: ValueKind,
): PanelStage[] {
  const counts = keys.map((k) => rows.filter((r) => r.column === k).length);
  const top = Math.max(0, ...counts);
  return keys.map((k, i) => {
    const inCol = rows.filter((r) => r.column === k);
    return {
      key: k,
      label: labels[k] ?? k,
      count: counts[i] ?? 0,
      share: share(counts[i] ?? 0, top),
      unit,
      rate_from_previous: null,
      kind: inCol.some((r) => r.synthetic) ? "synthetic" : kind,
      value_gbp: round2(inCol.reduce((a, r) => a + ((r.value_gbp as number | null) ?? 0), 0)),
    };
  });
}

// ---- Ideas: a board of cards, new → approved → executing → earning → killed ----------------

const IDEA_COLUMNS = ["new", "approved", "executing", "earning", "killed"] as const;
const IDEA_COLUMN_OF: Record<string, (typeof IDEA_COLUMNS)[number]> = {
  proposed: "new",
  parked: "new",
  passed: "approved",
  budget_pending: "approved",
  testing: "executing",
  succeeded: "earning",
  killed: "killed",
  failed: "killed",
};

const figureOf = (
  key: string,
  label: string,
  f: { value: number; label: "real" | "estimated" | "assumed" } | undefined,
  synthetic: boolean,
): PanelFigure => ({
  key,
  label,
  value: f ? f.value : null,
  unit: "gbp",
  kind: synthetic ? "synthetic" : (f?.label ?? "estimated"),
  note: null,
});

export async function ideasBoard(c: PageCtx): Promise<Out> {
  const latest = new Map<string, Awaited<ReturnType<Storage["ideaCards"]["list"]>>[number]>();
  for (const r of await c.storage.ideaCards.list({ limit: 10_000 })) {
    const prev = latest.get(r.card_id);
    if (!prev || r.version > prev.version) latest.set(r.card_id, r);
  }
  const open = await c.storage.decisions.list({ status: "open", type: "idea", limit: 1000 });
  const rows: PanelRow[] = [];
  for (const r of [...latest.values()].sort((a, b) => b.rank_value - a.rank_value)) {
    const column = IDEA_COLUMN_OF[r.status];
    if (!column) continue;
    const card = r.card as IdeaCard;
    if (c.args.function && card.taxonomy_node !== c.args.function) continue;
    if (c.args.market && r.market_key !== c.args.market) continue;
    // Confidence: the lowest current confidence among the card's evidence facts (as for opportunities).
    let confidence: number | null = null;
    for (const id of card.evidence.fact_ids.slice(0, 50)) {
      const [entity, field] = id.split(":");
      const f = entity && field ? await c.storage.facts.getCurrent(entity, field) : null;
      if (f) confidence = confidence === null ? f.confidence : Math.min(confidence, f.confidence);
    }
    const e = card.economics;
    const decision = open.find((d) => d.source_ref === `card:${r.card_id}@${r.version}`);
    rows.push({
      key: r.card_id,
      label: card.offer,
      detail: `${card.market.buyer}${card.market.industry ? ` · ${card.market.industry}` : ""}`,
      column,
      status_label: r.status.replaceAll("_", " "),
      plan_status: await planStatusFor(c.storage, r.card_id),
      value_gbp: e.first_year_value.value,
      figures: [
        figureOf("cost_to_serve", "Cost to serve", e.cost_to_serve.total, r.synthetic),
        figureOf("cost_to_acquire", "Cost to acquire", e.cost_to_acquire.total, r.synthetic),
        figureOf(
          "expected_revenue",
          "Expected revenue (first year)",
          e.first_year_value,
          r.synthetic,
        ),
        {
          key: "confidence",
          label: "Confidence",
          value: confidence === null ? null : round4(confidence),
          unit: "ratio",
          kind: r.synthetic ? "synthetic" : "real",
          note: "lowest among its evidence facts",
        },
      ],
      decision: decision
        ? {
            id: decision.id,
            options: decision.options,
            recommended: decision.recommended,
            safe_default: decision.safe_default,
            reason_for: ["fail"],
          }
        : null,
      synthetic: r.synthetic,
      drill: `/ideas/${r.card_id}`,
    });
  }
  const shown = rows.filter((r) => c.includeSynthetic || !r.synthetic);
  return {
    kind: "rows",
    rows,
    stages: columns(
      IDEA_COLUMNS,
      {
        new: "New",
        approved: "Approved",
        executing: "Executing",
        earning: "Earning",
        killed: "Killed",
      },
      shown,
      "ideas",
      "estimated",
    ),
    meta: { total: shown.length },
    note: "column value: expected first-year revenue of the cards in it (estimated)",
    empty: "No idea cards yet. Scouts raise signals; the planner turns them into cards here.",
  };
}

// ---- CRM: a pipeline board of companies by stage ------------------------------------------

const CRM_LABEL: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  engaged: "Engaged",
  replied: "Replied",
  claimed: "Claimed",
  customer: "Customer",
  lost: "Lost",
  opted_out: "Opted out",
};

export async function crmPipeline(c: PageCtx): Promise<Out> {
  // crmList is the CRM's own blind list: no arm or cohort on any row (rule 22).
  const all = (
    await crmList(c.storage, { includeSynthetic: c.includeSynthetic, limit: 100_000, offset: 0 })
  ).rows;
  const perColumn = Math.min(20, Math.max(1, Number(c.args.limit ?? 6) || 6));
  const rows: PanelRow[] = all.map((r) => ({
    key: r.entity_id,
    label: r.name,
    detail: r.next_step,
    column: r.stage,
    value_gbp: r.expected_value_gbp,
    figures: [
      {
        key: "value",
        label: r.stage === "customer" ? "Yearly value" : "Expected value",
        value: r.expected_value_gbp,
        unit: "gbp",
        kind: r.synthetic ? "synthetic" : (r.value_kind ?? "estimated"),
        note: null,
      },
    ],
    entity_id: r.entity_id,
    synthetic: r.synthetic,
    drill: `/crm/${r.entity_id}`,
  }));
  const stages = columns(CRM_STAGES, CRM_LABEL, rows, "companies", "estimated");
  // Each column shows its highest-value companies; the column header carries the full count and value.
  const shown = CRM_STAGES.flatMap((s) =>
    rows
      .filter((r) => r.column === s)
      .sort((a, b) => ((b.value_gbp as number) ?? 0) - ((a.value_gbp as number) ?? 0))
      .slice(0, perColumn),
  );
  for (const st of stages)
    st.note = st.count > perColumn ? `top ${perColumn} of ${st.count} by value` : null;
  return {
    kind: "rows",
    rows: shown,
    stages,
    meta: {
      total: rows.length,
      pipeline_value_gbp: round2(
        rows
          .filter((r) => !["customer", "lost", "opted_out"].includes(r.column as string))
          .reduce((a, r) => a + ((r.value_gbp as number | null) ?? 0), 0),
      ),
    },
    note: "column value: expected value of the companies in it (customers: yearly value, real)",
    empty: "The pipeline fills as leads are approved and contacted.",
  };
}

// ---- Board: heatmap of industry × field (what we'd sell) -----------------------------------

export async function boardHeatmap(c: PageCtx): Promise<Out> {
  const tiles = (await boardView(c.storage)).filter((t) => c.includeSynthetic || !t.synthetic);
  // Score (Archie, U3 gate): expected monthly profit per £1 of agent spend. For each live idea card:
  // its expected profit (first year of the test: customers × first-year margin − test budget) ÷ 12,
  // divided by the agent spend it plans (its test budget). The market takes its best card, and colour
  // is that scaled against the best market on the board (0–1). Estimated: card economics are estimates.
  // Profit per hour of Archie's time is kept for the hover text.
  const best = new Map<string, { perGbp: number; perHour: number }>();
  for (const t of tiles) {
    const cards = (await c.storage.ideaCards.forMarket(t.market_key)).filter(
      (x) => !["superseded", "killed", "failed"].includes(x.status),
    );
    for (const x of cards) {
      const e = (x.card as IdeaCard).economics;
      const budget = (x.card as IdeaCard).test.budget_gbp.value;
      if (budget <= 0) continue;
      const perGbp = e.expected_profit.value / 12 / budget;
      const prev = best.get(t.market_key);
      if (!prev || perGbp > prev.perGbp)
        best.set(t.market_key, { perGbp, perHour: e.profit_per_owner_hour.value });
    }
  }
  const top = Math.max(0, ...[...best.values()].map((b) => b.perGbp));
  const industries = new Map<string, PanelRow>();
  for (const t of tiles) {
    const industry = t.market_key.split(":")[1] ?? t.label;
    const row =
      industries.get(industry) ??
      ({
        key: industry,
        label: industry.replaceAll("_", " "),
        cells: [] as unknown[],
        synthetic: false,
      } as PanelRow);
    const b = best.get(t.market_key) ?? null;
    (row.cells as unknown[]).push({
      col: t.field.replaceAll("_", " "),
      intensity: b && b.perGbp > 0 ? share(b.perGbp, top) : 0,
      monthly_profit_per_gbp_spend: b ? round4(b.perGbp) : null,
      profit_per_hour_gbp: b ? round2(b.perHour) : null,
      spend_gbp: round2(t.spent_gbp + (c.includeSynthetic ? t.spent_synthetic_gbp : 0)),
      column: t.col,
      drill: "/board",
    });
    if (t.synthetic) row.synthetic = true;
    industries.set(industry, row);
  }
  return {
    kind: "rows",
    rows: [...industries.values()].sort((a, b) => a.label.localeCompare(b.label)),
    value_kind: "estimated",
    meta: { markets: tiles.length },
    note: "colour: best idea's expected monthly profit per £1 of agent spend, scaled to the best market (estimated); number: agent spend there so far; hover for profit per hour of your time",
    empty: "The Board fills as scouts find markets.",
  };
}

// ---- Inbox: sent, replies and positive-reply rate per playbook or test ---------------------

export async function inboxStrip(c: PageCtx): Promise<Out> {
  const ledger = await c.storage.ledgerRange({
    from: c.from,
    to: c.to,
    includeSynthetic: c.includeSynthetic,
    ...(c.playbook ? { playbook: c.playbook } : {}),
  });
  const groups = new Map<
    string,
    { sent: Set<string>; replied: Set<string>; positive: Set<string>; dry: boolean; synth: boolean }
  >();
  for (const r of ledger) {
    if (!["sent", "reply", "reply_positive"].includes(r.event)) continue;
    const exp = r.experiment_id;
    const key = exp ? `${r.playbook} · test ${exp}` : (r.playbook ?? "unattributed");
    const g = groups.get(key) ?? {
      sent: new Set<string>(),
      replied: new Set<string>(),
      positive: new Set<string>(),
      dry: false,
      synth: false,
    };
    const who = r.entity_id;
    if (r.event === "sent") g.sent.add(who);
    if (r.event === "reply" || r.event === "reply_positive") g.replied.add(who);
    if (r.event === "reply_positive") g.positive.add(who);
    g.dry ||= Boolean(r.dry_run);
    g.synth ||= Boolean(r.synthetic);
    groups.set(key, g);
  }
  const rate = (n: number, d: number) => (d > 0 ? round4(n / d) : null);
  const rows: PanelRow[] = [...groups.entries()]
    .sort((a, b) => b[1].sent.size - a[1].sent.size)
    .map(([key, g]) => ({
      key,
      label: key.replaceAll("_", " "),
      sent: g.sent.size,
      replies: g.replied.size,
      positive: g.positive.size,
      reply_rate: rate(g.replied.size, g.sent.size),
      positive_rate: rate(g.positive.size, g.sent.size),
      kind: g.synth ? "synthetic" : g.dry ? "dry_run" : "real",
      synthetic: g.synth,
    }));
  return {
    kind: "rows",
    rows,
    note: "companies contacted in the period; rates are per company sent to (positive = a positive reply)",
    empty: "Sends and replies show here per playbook once outreach goes out.",
  };
}

// ---- Vault: what agents learned this week -------------------------------------------------

export async function vaultLearned(c: PageCtx): Promise<Out> {
  const since = new Date(c.now.getTime() - 7 * 86_400_000).toISOString();
  const notes = (await vaultNotes(c.storage, await c.vault()))
    .filter((n) => n.author.startsWith("agent") && (n.updated_at ?? "") >= since)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  const rows: PanelRow[] = notes.slice(0, 20).map((n) => {
    const p = n.provenance;
    const labels = p.labels.filter((l) => l !== "synthetic");
    return {
      key: n.path,
      label: n.title,
      detail: [
        `by ${p.author}`,
        `${p.sources.length} source(s)`,
        `${p.ledger_rows.length} ledger row(s)`,
        ...labels,
      ].join(" · "),
      status: labels.includes("untrusted") ? "warn" : "info",
      started_at: n.updated_at,
      synthetic: p.labels.includes("synthetic"),
      drill: `/vault/${encodeURIComponent(n.path)}`,
    };
  });
  return {
    kind: "rows",
    rows,
    meta: { total: notes.length },
    note: "agent notes from the last 7 days, newest first, with where each came from",
    empty: "Nothing learned this week yet. Agent notes appear here with their sources.",
  };
}
