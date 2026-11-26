import { type InfraConfig, loadInfraConfig, loadTriggersConfig } from "@ae/config";
import type {
  Autonomy,
  PanelFigure,
  PanelPoint,
  PanelQuery,
  PanelResult,
  PanelRow,
  PanelStage,
  ValueKind,
} from "@ae/contracts";
import { PANEL_QUERIES } from "@ae/contracts";
import {
  buildDigest,
  type DecisionDeps,
  entityOfRef,
  homeFigures,
  K,
  KeyRing,
  loadBundledPlaybooks,
  needsYou,
  playbookDailyCap,
  spendTier,
} from "@ae/infra";
import type { KeyStore } from "@ae/ports";
import type { DailyRollupRow, Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";
import { type CacheStore, cacheMiddleware } from "./cache.ts";

/**
 * The cockpit's panel registry (cockpit UI plan §3.2): one read-only function per panel query, all
 * returning the one PanelResult shape, all passing the one guard (toPanelResult). Built only on
 * functions and tables that already exist: no new tables, no migrations. All maths here (rule 4).
 *
 * "Live" money means mode 'live' AND synthetic 0 AND dry_run 0 (Archie, 26 Nov 2026). Simulated rows
 * are only included with synthetic=1, and are then labelled (rule 10).
 */

const DAY_MS = 86_400_000;

export interface PanelFilters {
  /** ISO start (inclusive) and end (exclusive) of the window. */
  from: string;
  to: string;
  days: number;
  playbook: string | null;
  includeSynthetic: boolean;
  compare: boolean;
}

export interface PanelCtx extends PanelFilters {
  storage: Storage;
  cfg: InfraConfig;
  decisions: DecisionDeps;
  keys: KeyStore;
  now: Date;
  args: Record<string, string>;
}

type Raw = Omit<PanelResult, "query" | "as_of" | "from" | "to" | "synthetic_included">;

interface PanelDef {
  /** May the answer be up to 60 s old? Never for panels that read budgets, caps or controls. */
  cacheable: boolean;
  run: (c: PanelCtx) => Promise<Raw>;
}

// ---- shared helpers -------------------------------------------------------------------------

const round2 = (x: number) => {
  const r = Math.round(x * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Every day in [from, to), as YYYY-MM-DD. */
function daysIn(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = dayOf(from); d < dayOf(to) && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Live rows: mode 'live', not dry run, and not simulated unless asked for. */
const isLive = (r: DailyRollupRow, includeSynthetic: boolean) =>
  r.mode === "live" && !r.dry_run && (includeSynthetic || !r.synthetic);

async function liveRollups(c: PanelFilters & { storage: Storage }, from = c.from, to = c.to) {
  const rows = (await c.storage.dailyRollups.range({ from, to })).filter((r) =>
    isLive(r, c.includeSynthetic),
  );
  return c.playbook ? rows.filter((r) => r.playbook === c.playbook) : rows;
}

/** The previous window of the same length (compare=1). */
const previousWindow = (c: PanelFilters) => ({
  from: new Date(Date.parse(c.from) - (Date.parse(c.to) - Date.parse(c.from))).toISOString(),
  to: c.from,
});

const kindOf = (synthetic: boolean, base: ValueKind = "real"): ValueKind =>
  synthetic ? "synthetic" : base;

// ---- the ten queries ----------------------------------------------------------------------

const PRIMARY = ["revenue", "live_spend", "margin", "live_agents"];
const SECONDARY = ["mrr", "pipeline", "reply_rate", "cac", "cost_to_serve"];
const DOWN_IS_GOOD = new Set(["live_spend", "cac", "cost_to_serve"]);

async function kpiFigures(c: PanelCtx, from: string, to: string): Promise<PanelFigure[]> {
  const home = await homeFigures(c.storage, c.cfg, {
    from,
    to,
    ...(c.playbook ? { playbook: c.playbook } : {}),
    includeSynthetic: c.includeSynthetic,
  });
  const live = await liveRollups(c, from, to);
  const spend = live.reduce((a, r) => a + r.cost_gbp, 0);
  const dry = (await c.storage.dailyRollups.range({ from, to }))
    .filter((r) => r.mode === "live" && r.dry_run && (!c.playbook || r.playbook === c.playbook))
    .reduce((a, r) => a + r.cost_gbp, 0);
  const figures: PanelFigure[] = [
    ...home.figures,
    {
      key: "live_spend",
      label: "Live spend",
      value: round2(spend),
      unit: "gbp",
      kind: kindOf(live.some((r) => r.synthetic)),
      note: `real money spent by agents; £${round2(dry).toFixed(2)} of dry-run spend left out`,
    },
  ];
  return figures;
}

async function liveAgents(c: PanelCtx): Promise<PanelFigure> {
  const runs = (await c.storage.graphRuns.list({ mode: "live", limit: 500 })).filter(
    (r) =>
      ["pending", "running", "waiting"].includes(r.status) && (c.includeSynthetic || !r.synthetic),
  );
  const tasks = (await c.storage.tasks.list({ status: "running", limit: 500 })).filter(
    (t) => (c.includeSynthetic || !t.synthetic) && (!c.playbook || t.playbook === c.playbook),
  );
  const synth = runs.some((r) => r.synthetic) || tasks.some((t) => t.synthetic);
  return {
    key: "live_agents",
    label: "Live agents",
    value: runs.length + tasks.length,
    unit: "count",
    kind: kindOf(synth),
    note: `${tasks.length} task(s) running, ${runs.length} graph run(s) open (now, not the period)`,
  };
}

async function sparks(c: PanelCtx): Promise<Record<string, number[]>> {
  const end = dayOf(new Date(Date.parse(c.to) - 1).toISOString());
  const start = addDays(end, -13);
  const rows = await liveRollups(c, start, addDays(end, 1));
  const days = Array.from({ length: 14 }, (_, i) => addDays(start, i));
  const sum = (d: string, f: "cost_gbp" | "revenue_gbp") =>
    round2(rows.filter((r) => r.day === d).reduce((a, r) => a + r[f], 0));
  return {
    live_spend: days.map((d) => sum(d, "cost_gbp")),
    revenue: days.map((d) => sum(d, "revenue_gbp")),
  };
}

const kpis: PanelDef = {
  cacheable: true,
  run: async (c) => {
    const set = c.args.set === "primary" ? PRIMARY : c.args.set === "secondary" ? SECONDARY : null;
    const now = await kpiFigures(c, c.from, c.to);
    now.push(await liveAgents(c));
    const prevW = previousWindow(c);
    const prev = c.compare ? await kpiFigures(c, prevW.from, prevW.to) : [];
    const spark = await sparks(c);
    const order = set ?? [...PRIMARY, ...SECONDARY, "sends", "sales", "lift", "review_minutes"];
    const figures = order
      .map((key) => now.find((f) => f.key === key))
      .filter((f): f is PanelFigure => Boolean(f))
      .map((f) => {
        const p = prev.find((x) => x.key === f.key);
        const out: PanelFigure = { ...f, up_is_good: !DOWN_IS_GOOD.has(f.key) };
        if (spark[f.key]) out.spark = spark[f.key] as number[];
        // live_agents is a "now" count: it has no previous period.
        if (c.compare && f.key !== "live_agents") {
          const pv = p?.value ?? null;
          out.previous = pv;
          out.change = f.value !== null && pv !== null ? round4(f.value - pv) : null;
          out.change_ratio =
            f.value !== null && pv !== null && pv !== 0
              ? round4((f.value - pv) / Math.abs(pv))
              : null;
        }
        return out;
      });
    return {
      kind: "figures",
      figures,
      note: c.compare
        ? `compared with ${dayOf(prevW.from)} to ${dayOf(new Date(Date.parse(prevW.to) - 1).toISOString())}`
        : null,
      empty: "Figures appear once the ledger has sends, replies or payments.",
    };
  },
};

const money_by_day: PanelDef = {
  cacheable: true,
  run: async (c) => {
    const rows = await liveRollups(c);
    const days = daysIn(c.from, c.to);
    const point = (rs: DailyRollupRow[], d: string): PanelPoint => {
      const on = rs.filter((r) => r.day === d);
      const synthetic = on.some((r) => r.synthetic);
      return {
        day: d,
        revenue_gbp: round2(on.reduce((a, r) => a + r.revenue_gbp, 0)),
        spend_gbp: round2(on.reduce((a, r) => a + r.cost_gbp, 0)),
        ...(synthetic ? { synthetic: true } : {}),
      };
    };
    const revenue = round2(rows.reduce((a, r) => a + r.revenue_gbp, 0));
    const spend = round2(rows.reduce((a, r) => a + r.cost_gbp, 0));
    const meta = { revenue_gbp: revenue, spend_gbp: spend, net_gbp: round2(revenue - spend) };
    const empty =
      "Live revenue and spend appear here day by day once real money moves (dry run is left out).";
    if (c.args.split !== "playbook") {
      const series = rows.length ? days.map((d) => point(rows, d)) : [];
      return { kind: "series", series, meta, note: null, empty, value_kind: "real" };
    }
    // Spend is recorded per playbook; revenue per revenue path (it has no playbook), so revenue rows
    // are grouped under their revenue path.
    const groupOf = (r: DailyRollupRow) => r.playbook || r.revenue_path || "unattributed";
    const groups = [...new Set(rows.map(groupOf))].sort();
    let max = 0;
    const out: PanelRow[] = groups.map((g) => {
      const rs = rows.filter((r) => groupOf(r) === g);
      const series = days.map((d) => point(rs, d));
      for (const p of series) max = Math.max(max, p.revenue_gbp, p.spend_gbp);
      const rev = round2(rs.reduce((a, r) => a + r.revenue_gbp, 0));
      const sp = round2(rs.reduce((a, r) => a + r.cost_gbp, 0));
      return {
        key: g,
        label: g.replace(/_/g, " "),
        series,
        revenue_gbp: rev,
        spend_gbp: sp,
        ...(rs.some((r) => r.synthetic) ? { synthetic: true } : {}),
      };
    });
    return {
      kind: "rows",
      rows: out,
      value_kind: "real",
      meta: { ...meta, scale_max_gbp: round2(max) },
      note: "Every chart uses the same scale. Revenue has no playbook, so it is grouped by revenue path.",
      empty,
    };
  },
};

/**
 * Runway = pool balance ÷ average live daily spend over the last 7 complete days (Archie, 26 Nov).
 * Pool balance = every pool event (top-ups and adjustments) − live spend since the first pool event.
 * Live only, whatever the synthetic switch says: this is money that controls spending.
 */
export async function runwayFigures(storage: Storage, now: Date) {
  const events = await storage.poolEvents.list();
  const topups = events.filter((e) => e.kind === "topup");
  const today = dayOf(now.toISOString());
  if (!topups.length)
    return { recorded: false as const, balance: null, avg7: null, days: null, top_up_by: null };
  const first = dayOf(events[0]?.at ?? today);
  const live = (await storage.dailyRollups.range({ from: first, to: addDays(today, 1) })).filter(
    (r) => isLive(r, false),
  );
  const spent = live.reduce((a, r) => a + r.cost_gbp, 0);
  const balance = events.reduce((a, e) => a + e.amount_gbp, 0) - spent;
  const weekStart = addDays(today, -7);
  const avg7 =
    live.filter((r) => r.day >= weekStart && r.day < today).reduce((a, r) => a + r.cost_gbp, 0) / 7;
  const days = avg7 > 0 ? Math.max(0, balance) / avg7 : null;
  return {
    recorded: true as const,
    balance: round2(balance),
    avg7: round2(avg7),
    days: days === null ? null : Math.round(days * 10) / 10,
    top_up_by: days === null ? null : addDays(today, Math.floor(days)),
  };
}

const runway: PanelDef = {
  cacheable: false,
  run: async (c) => {
    const r = await runwayFigures(c.storage, c.now);
    const note = !r.recorded
      ? "record a top-up in Controls"
      : r.days === null
        ? "no live spend in the last 7 days, so the pool isn't running down"
        : `top up by ${r.top_up_by}`;
    return {
      kind: "figures",
      figures: [
        { key: "runway_days", label: "Runway", value: r.days, unit: "days", kind: "real", note },
        {
          key: "pool_balance",
          label: "Agent pool",
          value: r.balance,
          unit: "gbp",
          kind: "real",
          note: "top-ups and adjustments minus live spend",
        },
        {
          key: "avg_live_spend_7d",
          label: "Live spend a day (7-day average)",
          value: r.avg7,
          unit: "gbp",
          kind: "real",
          note: "the last 7 complete days; dry-run and simulated spend left out",
          up_is_good: false,
        },
      ],
      meta: { top_up_by: r.top_up_by },
      note,
      empty: "Runway shows once a top-up is recorded in Controls.",
    };
  },
};

const DECISION_LABEL: Record<string, string> = {
  lead: "Lead",
  draft: "Draft",
  print_batch: "Print batch",
  claim_publish: "Publish site",
  uncertain_effect: "Check an action",
  dead_letter: "Failed job",
  data_conflict: "Data conflict",
  quarantine: "Unmatched record",
  spend_tier: "Spend tier",
  autonomy: "Autonomy",
  key_failing: "Key failing",
  idea: "Idea",
  idea_budget: "Test budget",
  board: "Board",
  graph_plan: "Plan",
  promotion: "Promotion",
};

const needs_you: PanelDef = {
  // The decisions queue: a cached copy would show an item again after Archie decides it.
  cacheable: false,
  run: async (c) => {
    const open = await needsYou(c.decisions, { limit: 200 });
    const rows: PanelRow[] = [];
    for (const d of open.filter((x) => c.includeSynthetic || !x.synthetic).slice(0, 20)) {
      const ctx = (d.context ?? {}) as Record<string, unknown>;
      // The company a decision is about, so the guard can withhold holdout companies (rule 22).
      let entity = typeof ctx.entity_id === "string" ? ctx.entity_id : null;
      if (!entity && d.source_ref.startsWith("task:")) {
        const t = await c.storage.tasks.get(d.source_ref.slice(5));
        if (t) entity = entityOfRef(t.source_ref);
      }
      if (!entity && d.source_ref.startsWith("opportunity:"))
        entity = (await c.storage.opportunities.get(d.source_ref.slice(12)))?.entity_id ?? null;
      if (!entity && d.source_ref.startsWith("fact:")) entity = d.source_ref.split(":")[1] ?? null;
      const reasoning = ["rationale", "reasoning", "why"]
        .map((k) => ctx[k])
        .find((v) => typeof v === "string");
      rows.push({
        key: d.id,
        label: d.summary,
        detail: DECISION_LABEL[d.type] ?? d.type,
        type: d.type,
        money_at_stake_gbp: d.money_at_stake_gbp,
        money_kind: d.money_kind,
        options: d.options,
        recommended: d.recommended,
        safe_default: d.safe_default,
        deadline: d.deadline,
        reasoning: (reasoning as string | undefined) ?? null,
        entity_id: entity,
        synthetic: d.synthetic,
        drill:
          d.type === "graph_plan" && typeof ctx.graph_id === "string"
            ? `/plans/${ctx.graph_id}`
            : null,
      });
    }
    return {
      kind: "rows",
      rows,
      note: "highest money at stake first; every button goes through the one decisions path",
      empty: "Nothing needs you.",
    };
  },
};

const brief: PanelDef = {
  cacheable: true,
  run: async (c) => {
    const day = dayOf(new Date(c.now.getTime() - DAY_MS).toISOString());
    const stored = c.includeSynthetic ? null : await c.storage.digests.latest();
    const d =
      (stored?.body as Awaited<ReturnType<typeof buildDigest>> | undefined) ??
      (await buildDigest(c.storage, c.cfg, { day, includeSynthetic: c.includeSynthetic }));
    const synthetic = d.label !== "real";
    const runs = (await c.storage.dailyRollups.range({ from: d.day, to: addDays(d.day, 1) }))
      .filter((r) => isLive(r, c.includeSynthetic))
      .reduce((a, r) => a + r.runs, 0);
    const h = d.happened;
    const cap = c.cfg.caps.global_per_day_gbp;
    const lines: PanelRow[] = [
      {
        key: "activity",
        label: `${runs} live run(s), ${h.sent ?? 0} sent, ${h.reply ?? 0} repl${(h.reply ?? 0) === 1 ? "y" : "ies"}`,
        detail: `on ${d.day}`,
        status: "info",
      },
      {
        key: "earned",
        label: d.earned_gbp > 0 ? `£${d.earned_gbp.toFixed(2)} earned` : "No revenue",
        detail: (h.paid ?? 0) > 0 ? `${h.paid} payment(s)` : null,
        status: d.earned_gbp > 0 ? "ok" : "info",
        earned_gbp: d.earned_gbp,
      },
      {
        key: "spent",
        label: `£${d.spent_gbp.toFixed(2)} spent of £${cap.toFixed(2)} daily budget`,
        detail: "live spend that counts against the caps",
        status: d.spent_gbp > cap ? "bad" : "ok",
        spent_gbp: d.spent_gbp,
        cap_gbp: cap,
      },
      {
        key: "waiting",
        label: d.waiting.open ? `${d.waiting.open} item(s) waiting for you` : "Nothing waiting",
        detail: d.defaulted.length
          ? `${d.defaulted.length} defaulted (recorded as defaulted)`
          : null,
        status: d.waiting.open ? "warn" : "ok",
        drill: "/",
      },
    ];
    const rows = lines.map((r) => ({ ...r, ...(synthetic ? { synthetic: true } : {}) }));
    return {
      kind: "rows",
      rows,
      note: `the digest for ${d.day}`,
      empty: "The brief appears after the first daily digest.",
    };
  },
};

const live_runs: PanelDef = {
  cacheable: true,
  run: async (c) => {
    const rows: PanelRow[] = [];
    for (const status of ["running", "queued", "awaiting_approval"] as const) {
      for (const t of await c.storage.tasks.list({ status, limit: 50 })) {
        if (c.playbook && t.playbook !== c.playbook) continue;
        const step =
          (t.state as { step?: unknown; current_step?: unknown }).step ??
          (t.state as { current_step?: unknown }).current_step;
        rows.push({
          key: `task:${t.task_id}`,
          label: t.playbook.replace(/_/g, " "),
          detail: typeof step === "string" ? `step: ${step}` : status.replace(/_/g, " "),
          status: status === "running" ? "running" : "waiting",
          cost_gbp: t.cost_gbp,
          started_at: t.created_at,
          entity_id: entityOfRef(t.source_ref),
          synthetic: t.synthetic,
          drill: status === "awaiting_approval" ? "/" : null,
        });
      }
    }
    for (const r of await c.storage.graphRuns.list({ mode: "live", limit: 100 })) {
      if (!["pending", "running", "waiting", "paused"].includes(r.status)) continue;
      if (c.playbook && r.graph_id !== c.playbook) continue;
      rows.push({
        key: `run:${r.run_id}`,
        label: r.graph_id.replace(/_/g, " "),
        detail: r.pause_reason ?? `graph run, ${r.status}`,
        status: r.status === "paused" ? "paused" : r.status === "running" ? "running" : "waiting",
        cost_gbp: r.cost_so_far_gbp,
        started_at: r.started_at,
        synthetic: r.synthetic,
        drill: null,
      });
    }
    for (const w of [
      ...(await c.storage.workflows.list({ status: "running", limit: 20 })),
      ...(await c.storage.workflows.list({ status: "paused", limit: 20 })),
    ] as {
      id: string;
      workflow: string;
      status: string;
      created_at?: string;
      synthetic?: boolean;
    }[]) {
      rows.push({
        key: `wf:${w.id}`,
        label: w.workflow.replace(/_/g, " "),
        detail: `workflow, ${w.status}`,
        status: w.status === "paused" ? "paused" : "running",
        cost_gbp: null,
        started_at: w.created_at ?? null,
        synthetic: Boolean(w.synthetic),
        drill: "/controls",
      });
    }
    return {
      kind: "rows",
      rows: rows.slice(0, 30),
      value_kind: "real",
      meta: { total: rows.length },
      note: null,
      empty: "No agent is running. Runs show here while they work or wait for you.",
    };
  },
};

const APPROVED = ["passed", "budget_pending", "testing", "succeeded"];

const pipeline: PanelDef = {
  cacheable: true,
  run: async (c) => {
    const latest = new Map<string, { status: string; synthetic: boolean; version: number }>();
    for (const r of await c.storage.ideaCards.list({ limit: 10_000 })) {
      if (!c.includeSynthetic && r.synthetic) continue;
      const prev = latest.get(r.card_id);
      if (!prev || r.version > prev.version) latest.set(r.card_id, r);
    }
    const cards = [...latest.values()].filter((x) => x.status !== "superseded");
    const synth = cards.some((x) => x.synthetic);
    const approved = cards.filter((x) => APPROVED.includes(x.status)).length;
    const executing = cards.filter((x) => x.status === "testing").length;
    // Revenue is recorded per revenue path, not per idea: the last two stages count revenue paths.
    const rows = await liveRollups(c);
    const paths = new Map<string, { rev: number; cost: number }>();
    for (const r of rows) {
      const k = r.revenue_path || "unattributed";
      const p = paths.get(k) ?? { rev: 0, cost: 0 };
      p.rev += r.revenue_gbp;
      p.cost += r.cost_gbp;
      paths.set(k, p);
    }
    const earning = [...paths.values()].filter((p) => p.rev > 0).length;
    const profitable = [...paths.values()].filter((p) => p.rev > 0 && p.rev > p.cost).length;
    const k = kindOf(synth);
    const rate = (a: number, b: number) => (b > 0 ? round4(a / b) : null);
    const counts = [cards.length, approved, executing, earning, profitable];
    const top = Math.max(...counts);
    const share = (n: number) => (top > 0 ? round4(n / top) : 0);
    const stages: PanelStage[] = [
      {
        key: "ideas",
        label: "Ideas",
        count: cards.length,
        share: share(cards.length),
        unit: "ideas",
        rate_from_previous: null,
        kind: k,
      },
      {
        key: "approved",
        label: "Approved",
        count: approved,
        share: share(approved),
        unit: "ideas",
        rate_from_previous: rate(approved, cards.length),
        kind: k,
      },
      {
        key: "executing",
        label: "Executing",
        count: executing,
        share: share(executing),
        unit: "ideas",
        rate_from_previous: rate(executing, approved),
        kind: k,
      },
      {
        key: "first_revenue",
        label: "First revenue",
        count: earning,
        share: share(earning),
        unit: "revenue paths",
        rate_from_previous: null,
        kind: "real",
        note: "revenue paths with live revenue in the period",
      },
      {
        key: "profitable",
        label: "Profitable",
        count: profitable,
        share: share(profitable),
        unit: "revenue paths",
        rate_from_previous: rate(profitable, earning),
        kind: "real",
        note: "revenue above live spend in the period",
      },
    ];
    return {
      kind: "stages",
      stages: cards.length || earning ? stages : [],
      note: "Ideas count idea cards; the last two stages count revenue paths, so there is no rate between them.",
      empty: "The pipeline fills as ideas are proposed in Ideas.",
    };
  },
};

const playbook_board: PanelDef = {
  // Reads spend caps: never cached.
  cacheable: false,
  run: async (c) => {
    const bundled = await loadBundledPlaybooks();
    const live = await liveRollups(c);
    const day = `${dayOf(c.now.toISOString())}T00:00:00.000Z`;
    // Revenue events carry a task id: attribute each to its task's playbook. Test-mode money is left out.
    const revenueBy = new Map<string, number>();
    for (const e of await c.storage.revenueEvents.range({ from: c.from, to: c.to })) {
      if (e.test_mode) continue;
      const t = e.task_id ? await c.storage.tasks.get(e.task_id) : null;
      const k = t?.playbook ?? `${e.revenue_path} (no playbook)`;
      revenueBy.set(k, (revenueBy.get(k) ?? 0) + e.amount_gbp);
    }
    const rows: PanelRow[] = [];
    for (const [name, pb] of [...bundled].sort(([a], [b]) => a.localeCompare(b))) {
      if (name.startsWith("_") || (c.playbook && name !== c.playbook)) continue;
      const tier = await spendTier(c.storage, name);
      const cap = playbookDailyCap(c.cfg, name, tier);
      const today = await c.storage.costEvents.spendSince(day, {
        playbook: name,
        excludeSteps: c.cfg.caps.exclude_steps,
      });
      const spend = live.filter((r) => r.playbook === name).reduce((a, r) => a + r.cost_gbp, 0);
      const revenue = revenueBy.get(name) ?? 0;
      rows.push({
        key: name,
        label: name.replace(/_/g, " "),
        revenue_gbp: round2(revenue),
        spend_gbp: round2(spend),
        net_gbp: round2(revenue - spend),
        roi: spend > 0 ? round4((revenue - spend) / spend) : null,
        autonomy: ((await c.storage.controls.get<Autonomy>(K.autonomy(name))) ??
          pb.spec.autonomy) as string,
        killed: (await c.storage.controls.get<boolean>(K.playbook(name))) ?? false,
        tier,
        cap_today_gbp: round2(cap),
        spent_today_gbp: round2(today),
        cap_used: cap > 0 ? round4(today / cap) : null,
        kind: "real",
        drill: "/controls",
      });
    }
    for (const [k, v] of revenueBy)
      if (!bundled.has(k))
        rows.push({
          key: k,
          label: k.replace(/_/g, " "),
          revenue_gbp: round2(v),
          spend_gbp: 0,
          net_gbp: round2(v),
          roi: null,
          kind: "real",
        });
    rows.sort(
      (a, b) => (b.net_gbp as number) - (a.net_gbp as number) || a.key.localeCompare(b.key),
    );
    const top = Math.max(0, ...rows.map((r) => Math.abs(r.net_gbp as number)));
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.bar_share = top > 0 ? round4(Math.abs(r.net_gbp as number) / top) : 0;
    });
    const anyMoney = rows.some(
      (r) => (r.revenue_gbp as number) !== 0 || (r.spend_gbp as number) !== 0,
    );
    return {
      kind: "rows",
      rows,
      value_kind: "real",
      meta: { has_money: anyMoney ? 1 : 0 },
      note: "ranked by live revenue minus live spend in the period; today's spend against each cap",
      empty: "Playbooks rank here once they earn or spend real money.",
    };
  },
};

const spend_split: PanelDef = {
  // Shows caps: never cached.
  cacheable: false,
  run: async (c) => {
    const group = c.args.group === "agent" ? "agent" : "playbook";
    const day = `${dayOf(c.now.toISOString())}T00:00:00.000Z`;
    const ex = c.cfg.caps.exclude_steps;
    const totals = new Map<string, { period: number; synthetic: boolean }>();
    if (group === "playbook") {
      for (const r of await liveRollups(c)) {
        if (r.cost_gbp === 0) continue;
        const k = r.playbook || "unattributed";
        const t = totals.get(k) ?? { period: 0, synthetic: false };
        t.period += r.cost_gbp;
        t.synthetic ||= r.synthetic;
        totals.set(k, t);
      }
    } else {
      // "Agent" = the step (role) or graph node that spent it, grouped from cost_events.
      for (const e of await c.storage.costEvents.range({
        from: c.from,
        to: c.to,
        modes: ["live"],
      })) {
        if (e.dry_run || (!c.includeSynthetic && e.synthetic)) continue;
        if (c.playbook && e.playbook !== c.playbook) continue;
        const k = e.step_id ?? e.node_id ?? e.category;
        const t = totals.get(k) ?? { period: 0, synthetic: false };
        t.period += e.amount_gbp;
        t.synthetic ||= e.synthetic;
        totals.set(k, t);
      }
    }
    const sum = [...totals.values()].reduce((a, t) => a + t.period, 0);
    const rows: PanelRow[] = [];
    for (const [k, t] of [...totals].sort((a, b) => b[1].period - a[1].period)) {
      const row: PanelRow = {
        key: k,
        label: k.replace(/_/g, " "),
        spend_gbp: round2(t.period),
        share: sum > 0 ? round4(t.period / sum) : 0,
        ...(t.synthetic ? { synthetic: true } : {}),
      };
      if (group === "playbook" && k !== "unattributed") {
        const cap = playbookDailyCap(c.cfg, k, await spendTier(c.storage, k));
        const today = await c.storage.costEvents.spendSince(day, { playbook: k, excludeSteps: ex });
        row.cap_today_gbp = round2(cap);
        row.spent_today_gbp = round2(today);
        row.cap_used = cap > 0 ? round4(today / cap) : null;
      }
      rows.push(row);
    }
    const capDay = c.cfg.caps.global_per_day_gbp;
    const today = await c.storage.costEvents.spendSince(day, { excludeSteps: ex });
    return {
      kind: "rows",
      rows,
      value_kind: "real",
      meta: {
        total_gbp: round2(sum),
        group,
        global_cap_today_gbp: round2(capDay),
        global_spent_today_gbp: round2(today),
        global_cap_used: capDay > 0 ? round4(today / capDay) : null,
      },
      note: `live spend in the period by ${group}; today's spend is what counts against the caps`,
      empty: "Live spend splits here once agents spend real money (dry run is left out).",
    };
  },
};

const health: PanelDef = {
  // Shows the kill switch and failing keys: never cached, so a switch you just flipped shows at once.
  cacheable: false,
  run: async (c) => {
    const s = c.storage;
    const killed = (await s.controls.get<boolean>(K.global)) ?? c.cfg.kill_switch_default_on;
    const paused = (await s.controls.get<boolean>(K.queuePaused)) ?? false;
    const beats = (await s.runtimeStatus.all()).filter((b) => b.name !== "poll_cursor");
    const staleMin = loadTriggersConfig().fallback_poll.feed_stale_minutes;
    const ages = beats.map((b) => Math.round((c.now.getTime() - Date.parse(b.at)) / 60_000));
    const oldest = ages.length ? Math.max(...ages) : null;
    const dead = (await s.deadLetters.list({ open: true, limit: 100 })).length;
    const uncertain = (await s.effects.unresolved(100)).length;
    const keys = await new KeyRing(c.keys, s).list();
    const failing = keys.filter((k) => k.status === "failing");
    const alerts = (await s.alerts.list({ unacknowledged: true, limit: 1000 })).length;
    const rows: PanelRow[] = [
      {
        key: "kill_switch",
        label: killed ? "Kill switch on (dry run)" : "Kill switch off (live)",
        status: killed ? "warn" : "ok",
        drill: "/controls",
      },
      {
        key: "queue",
        label: paused ? "Queue paused" : "Queue running",
        status: paused ? "warn" : "ok",
        drill: "/controls",
      },
      {
        key: "heartbeats",
        label: oldest === null ? "No heartbeat yet" : `Oldest heartbeat ${oldest} min ago`,
        detail: `${beats.length} part(s) reporting`,
        status: oldest === null ? "info" : oldest > staleMin ? "warn" : "ok",
        drill: "/controls",
      },
      {
        key: "dead_letters",
        label: `${dead} failed job(s)`,
        status: dead ? "bad" : "ok",
        drill: "/controls",
      },
      {
        key: "uncertain_effects",
        label: `${uncertain} uncertain action(s)`,
        status: uncertain ? "bad" : "ok",
        drill: "/controls",
      },
      {
        key: "keys",
        label: failing.length ? `${failing.length} key(s) failing` : "Keys OK",
        detail:
          failing.map((k) => k.name).join(", ") ||
          `${keys.filter((k) => k.status === "unset").length} not set`,
        status: failing.length ? "bad" : "ok",
        drill: "/controls/keys",
      },
      {
        key: "alerts",
        label: `${alerts} open alert(s)`,
        status: alerts ? "warn" : "ok",
        drill: "/controls",
      },
    ];
    return {
      kind: "rows",
      rows,
      note: null,
      empty: "Health checks appear once the runtime reports.",
    };
  },
};

export const PANELS: Record<PanelQuery, PanelDef> = {
  kpis,
  money_by_day,
  runway,
  needs_you,
  brief,
  live_runs,
  pipeline,
  playbook_board,
  spend_split,
  health,
};

/** Panel queries that may be served from the 60-second cache (everything that doesn't read caps). */
export const CACHEABLE_PANELS = PANEL_QUERIES.filter((q) => PANELS[q].cacheable);

// ---- the shared guard ---------------------------------------------------------------------

export class PanelRefused extends Error {}

/** A field named like a secret is refused outright (rule 20). */
export const SECRET_FIELD =
  /secret|token|passw|api_?key|private_?key|credential|authori[sz]ation|bearer|signature/i;
/** A value shaped like a key (Stripe, GitHub, Slack, AWS, PEM, JWT) is refused outright (rule 20). */
export const SECRET_VALUE =
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{6,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
/** Assignment details that would reveal the holdout (rule 22). */
const ARM_FIELDS = new Set(["arm", "cohort", "cohort_id"]);

export interface GuardCtx {
  includeSynthetic: boolean;
  /** Company numbers in the random holdout. */
  holdout: Set<string>;
}

const mentionsHoldout = (v: unknown, holdout: Set<string>): boolean => {
  if (!holdout.size) return false;
  if (typeof v === "string") return holdout.has(v) || holdout.has(entityOfRef(v));
  if (Array.isArray(v)) return v.some((x) => mentionsHoldout(x, holdout));
  if (v && typeof v === "object") return Object.values(v).some((x) => mentionsHoldout(x, holdout));
  return false;
};

/**
 * Every panel result passes here (cockpit UI plan §3.2): drops holdout rows (rule 22), drops simulated
 * rows unless asked for and labels them when included (rule 10), refuses any secret-like field or value
 * (rule 20), and rounds money to pennies.
 */
export function toPanelResult(
  query: string,
  raw: Raw,
  window: { from: string; to: string },
  g: GuardCtx,
  now: Date = new Date(),
): PanelResult {
  let synthetic = false;
  const clean = (v: unknown, key: string, gbp: boolean): unknown => {
    if (typeof v === "string") {
      if (SECRET_VALUE.test(v))
        throw new PanelRefused(`refused a secret-like value in ${query}.${key}`);
      return v;
    }
    if (typeof v === "number") return gbp && Number.isFinite(v) ? round2(v) : v;
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const o = item as Record<string, unknown>;
          if (mentionsHoldout(o, g.holdout)) continue;
          const sim = o.synthetic === true || o.kind === "synthetic";
          if (sim && !g.includeSynthetic) continue;
          const c = clean(o, key, gbp) as Record<string, unknown>;
          if (sim) {
            synthetic = true;
            c.synthetic = true;
            c.kind = "synthetic";
          }
          out.push(c);
        } else out.push(clean(item, key, gbp));
      }
      return out;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const money = o.unit === "gbp";
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        if (SECRET_FIELD.test(k))
          throw new PanelRefused(`refused a secret-like field ${query}.${k}`);
        if (ARM_FIELDS.has(k)) continue;
        const isMoney =
          k.endsWith("_gbp") ||
          (money && ["value", "previous", "change", "goal", "spark", "ci95"].includes(k));
        out[k] = clean(x, k, isMoney);
      }
      return out;
    }
    return v;
  };
  const body = clean(raw, "", false) as Raw;
  return {
    query,
    as_of: now.toISOString(),
    from: window.from,
    to: window.to,
    ...body,
    ...(g.includeSynthetic && synthetic && body.value_kind
      ? { value_kind: "synthetic" as const }
      : {}),
    synthetic_included: g.includeSynthetic && synthetic,
  };
}

/** Company numbers in the random holdout of any cohort (simulated cohorts included: never shown). */
export async function holdoutEntities(storage: Storage): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of await storage.cohorts.list({ includeSynthetic: true, limit: 10_000 }))
    for (const m of await storage.cohorts.members(c.id))
      if (m.arm === "holdout") out.add(m.entity_id);
  return out;
}

// ---- the route ------------------------------------------------------------------------------

const Filters = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  playbook: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  synthetic: z.enum(["0", "1"]).optional(),
  compare: z.enum(["0", "1"]).optional(),
  /** A period preset (the filter bar's 7 / 30 / 90): the last N days ending `to` (or today). */
  days: z.coerce.number().int().min(1).max(366).optional(),
  set: z.enum(["primary", "secondary"]).optional(),
  split: z.enum(["playbook"]).optional(),
  group: z.enum(["playbook", "agent"]).optional(),
});

/** Default view (Archie, 26 Nov): the last 30 days, live only, compare on. */
export function parseFilters(q: z.infer<typeof Filters>, now: Date): PanelFilters {
  const to = q.to ? new Date(`${q.to}T00:00:00Z`) : now;
  const toEnd = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
  const fromIso = q.from
    ? `${q.from}T00:00:00.000Z`
    : new Date(toEnd.getTime() - 30 * DAY_MS).toISOString();
  const from =
    fromIso < toEnd.toISOString() ? fromIso : new Date(toEnd.getTime() - DAY_MS).toISOString();
  return {
    from,
    to: toEnd.toISOString(),
    days: Math.round((toEnd.getTime() - Date.parse(from)) / DAY_MS),
    playbook: q.playbook ?? null,
    includeSynthetic: q.synthetic === "1",
    compare: q.compare !== "0",
  };
}

export function mountPanels(
  // biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
  app: Hono<any>,
  deps: {
    storage: (env: unknown) => Storage;
    decisions: (env: unknown) => DecisionDeps;
    keys: (env: unknown) => KeyStore;
    cache?: (env: unknown) => CacheStore | null;
    now?: () => Date;
  },
) {
  // Cacheable panels only: budgets, caps, controls and the decisions queue are always live.
  if (deps.cache) {
    const cached = cacheMiddleware(deps.cache);
    app.use("/api/panels/:name", async (c, next) => {
      const name = c.req.param("name") as PanelQuery;
      return PANEL_QUERIES.includes(name) && PANELS[name].cacheable ? cached(c, next) : next();
    });
  }
  app.get("/api/panels/:name", async (c) => {
    const name = c.req.param("name") as PanelQuery;
    if (!PANEL_QUERIES.includes(name)) return c.json({ error: "unknown_panel" }, 404);
    const q = Filters.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_request", issues: q.error.issues }, 400);
    if (!PANELS[name].cacheable) c.header("cache-control", "no-store");
    const now = deps.now?.() ?? new Date();
    const f = parseFilters(q.data, now);
    const storage = deps.storage(c.env);
    const args: Record<string, string> = {};
    for (const k of ["set", "split", "group"] as const)
      if (q.data[k]) args[k] = q.data[k] as string;
    const raw = await PANELS[name].run({
      ...f,
      storage,
      cfg: loadInfraConfig(),
      decisions: deps.decisions(c.env),
      keys: deps.keys(c.env),
      now,
      args,
    });
    try {
      return c.json(
        toPanelResult(
          name,
          raw,
          f,
          { includeSynthetic: f.includeSynthetic, holdout: await holdoutEntities(storage) },
          now,
        ),
      );
    } catch (e) {
      if (e instanceof PanelRefused) return c.json({ error: "refused", reason: e.message }, 500);
      throw e;
    }
  });
}
