import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";

/**
 * Where every table lives (data layer plan, step 2). Three D1 databases on Cloudflare, three SQLite
 * files locally, plus one local-only file for the Node runner's workflow engine:
 * - core (`agent-engine`, binding DB): work, approvals, ideas, opportunities, customers, money, graphs;
 * - facts (`agent-engine-facts`, FACTS): verification, universe, measurement, the opportunity engine;
 * - telemetry (`agent-engine-telemetry`, TELEMETRY): the run log and runtime health;
 * - local (Node only): the full workflow step and event tables. On Cloudflare, Workflows keep their own.
 *
 * Graph run state isn't here: it's in the RunState Durable Objects (run-store.ts).
 * A static test checks every table appears exactly once, that every SQL string in this package touches
 * one store only, and that no foreign key crosses a store.
 */
export type Store = "core" | "facts" | "telemetry" | "local";
export const D1_STORES = ["core", "facts", "telemetry"] as const;
export type D1Store = (typeof D1_STORES)[number];

const FACTS = [
  "runs",
  "entities",
  "claims",
  "claim_observations",
  "claim_rejections",
  "claim_supersessions",
  "verified_facts",
  "verified_fact_versions",
  "universe_members",
  "ingest_progress",
  "verification_requests",
  "quarantined_matches",
  "dropped_fields",
  "source_pauses",
  "golden_entities",
  "blind_checks",
  "drift_metrics",
  "signal_values",
  "module_runs",
  "backtests",
  "weight_suggestions",
  "page_cuts",
] as const;

const TELEMETRY = ["run_log", "trigger_stats", "runtime_status", "dead_letters"] as const;

const LOCAL = ["workflow_steps", "workflow_events"] as const;

const CORE = [
  // work and approvals
  "tasks",
  "approvals",
  "playbook_examples",
  "review_sessions",
  "decisions",
  "owner_approvals",
  "decision_log",
  "controls",
  "alerts",
  "digests",
  "key_registry",
  "external_effects",
  // ideas
  "hypotheses",
  "hypothesis_imports",
  "hypothesis_score_history",
  "idea_matrix",
  "idea_cards",
  "idea_thread",
  "board_tiles",
  "board_moves",
  "experiments",
  "scout_signals",
  // opportunities and outcomes
  "opportunities",
  "outcomes",
  "outreach_cohorts",
  "cohort_members",
  // customers and outreach
  "customers",
  "watches",
  "watch_alerts",
  "outbox",
  "followups",
  "suppressions",
  "letters",
  "print_batches",
  "demo_pages",
  "demo_visits",
  "site_claims",
  "mail_messages",
  "note_versions",
  // graph layer (summaries; per-run state is in the Durable Objects)
  "graph_specs",
  "graph_runs",
  "graph_shapes",
  "promoted_playbooks",
  "sandbox_reports",
  // money
  "budget_events",
  "cost_events",
  "revenue_events",
  "pool_events",
  "payments_ledger",
  "x402_requests",
  "daily_rollups",
  // runtime: one row per workflow instance (the index the dashboard lists)
  "workflow_instances",
  // the run store's own tables, when it sits beside the core database (tests, gates)
  "run_node_runs",
  "run_state_values",
] as const;

export const PLACEMENT: Readonly<Record<string, Store>> = Object.freeze({
  ...Object.fromEntries(CORE.map((t) => [t, "core" as const])),
  ...Object.fromEntries(FACTS.map((t) => [t, "facts" as const])),
  ...Object.fromEntries(TELEMETRY.map((t) => [t, "telemetry" as const])),
  ...Object.fromEntries(LOCAL.map((t) => [t, "local" as const])),
});

/** Every table that leaves the old single database for another store (the split migration). */
export const MOVED_OUT_OF_CORE: readonly string[] = [...FACTS, ...TELEMETRY, ...LOCAL];

export class CrossStoreError extends Error {}

const TABLE_REF =
  /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?|ON(?=\s+[a-z_]+\s*\())\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

/** The known tables a SQL statement names (CTE names, functions and unknown names are ignored). */
export function tablesIn(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(TABLE_REF)) {
    const t = (m[1] as string).toLowerCase();
    if (t in PLACEMENT) out.add(t);
  }
  return [...out];
}

const cache = new Map<string, Store>();

/** The one store a statement runs on. Statements naming no known table (PRAGMA, migrations) → core. */
export function storeOf(sql: string): Store {
  const hit = cache.get(sql);
  if (hit) return hit;
  const stores = new Set(tablesIn(sql).map((t) => PLACEMENT[t] as Store));
  if (stores.size > 1)
    throw new CrossStoreError(
      `one statement touches ${[...stores].join(" and ")}: ${sql.slice(0, 120)}`,
    );
  const s: Store = stores.values().next().value ?? "core";
  if (cache.size < 5000) cache.set(sql, s);
  return s;
}

export type StoreDrivers = { core: SqlDriver; facts: SqlDriver; telemetry: SqlDriver } & {
  local?: SqlDriver;
};

/**
 * One SqlDriver over the stores: each statement goes to the store of the tables it names. A batch must
 * stay inside one store (a D1 batch is atomic only within one database), so a mixed batch is refused.
 */
export function routedDriver(d: StoreDrivers): SqlDriver & { stores: StoreDrivers } {
  const pick = (s: Store): SqlDriver => {
    const drv = d[s];
    if (!drv) throw new Error(`the ${s} store isn't available here`);
    return drv;
  };
  return {
    dialect: d.core.dialect,
    stores: d,
    all: <T>(sql: string, params?: SqlValue[]) => pick(storeOf(sql)).all<T>(sql, params),
    run: (sql: string, params?: SqlValue[]) => pick(storeOf(sql)).run(sql, params),
    async batch(statements: SqlStatement[]) {
      if (!statements.length) return;
      const stores = new Set(statements.map((s) => storeOf(s.sql)));
      if (stores.size > 1)
        throw new CrossStoreError(`one batch touches ${[...stores].join(" and ")}`);
      await pick(stores.values().next().value as Store).batch(statements);
    },
    async close() {
      const all = new Set<SqlDriver>([d.core, d.facts, d.telemetry, ...(d.local ? [d.local] : [])]);
      for (const drv of all) await drv.close();
    },
  };
}
