import type { SqlDriver, SqlValue } from "./driver.ts";

/**
 * Task graph storage (graph plan, G0): specs, sandbox reports, runs, node runs, state values, the
 * decision log (Archie's reasons; never the outcome ledger), shapes, promoted playbooks, and the three
 * money ledgers (cost, revenue, pool), which are append-only.
 */
type Row = Record<string, unknown>;
const pj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : null);
const nowIso = () => new Date().toISOString();
const bool = (v: unknown) => Number(v) === 1;

export type GraphSpecStatus =
  | "drafting"
  | "probing"
  | "sandboxing"
  | "ready"
  | "approved"
  | "running"
  | "done"
  | "rejected"
  | "couldnt_plan"
  | "superseded";

export interface GraphSpecRow {
  graph_id: string;
  version: number;
  parent_version: number | null;
  task_id: string;
  opportunity_id: string | null;
  hypothesis_id: string | null;
  spec: unknown;
  content_hash: string | null;
  registry_version: string | null;
  compiled: unknown;
  lane: "open" | "licensed" | null;
  worst_case_cost_gbp: number | null;
  autonomy: "L0" | "L1" | "L2" | "L3" | null;
  shape_fingerprint: string | null;
  status: GraphSpecStatus;
  attempt: number;
  synthetic: boolean;
  created_by: string;
  created_at: string;
}
export interface GraphRunRow {
  run_id: string;
  graph_id: string;
  version: number;
  instance_id: string | null;
  mode: "live" | "sandbox" | "probe";
  status: "pending" | "running" | "waiting" | "paused" | "done" | "failed" | "killed";
  cost_so_far_gbp: number;
  pause_reason: string | null;
  started_at: string;
  ended_at: string | null;
  outcome_id: string | null;
  synthetic: boolean;
}
export interface GraphNodeRunRow {
  run_id: string;
  node_id: string;
  iteration: number;
  status: "pending" | "running" | "waiting" | "done" | "failed" | "skipped" | "paused";
  started_at: string | null;
  ended_at: string | null;
  cost_gbp: number;
  output_ref: string | null;
  recorded_model_output: unknown;
  check_results: unknown;
  error: string | null;
}
export interface CostEventRow {
  event_id: string;
  at: string;
  run_id: string | null;
  graph_id: string | null;
  graph_version: number | null;
  node_id: string | null;
  task_id: string | null;
  opportunity_id: string | null;
  revenue_path: string | null;
  shape_fingerprint: string | null;
  mode: "sandbox" | "probe" | "planner" | "live";
  category: "model" | "tool" | "infra" | "third_party";
  unit: string;
  quantity: number;
  unit_price_gbp: number;
  amount_gbp: number;
  price_table_version: string;
  synthetic: boolean;
  dry_run: boolean;
  playbook?: string | null;
  step_id?: string | null;
}
export interface DailyRollupRow {
  day: string;
  revenue_path: string;
  playbook: string;
  mode: "live" | "sandbox" | "probe" | "planner";
  synthetic: boolean;
  dry_run: boolean;
  cost_gbp: number;
  revenue_gbp: number;
  cost_events: number;
  runs: number;
}
export interface RevenueEventRow {
  event_id: string;
  at: string;
  run_id: string | null;
  task_id: string | null;
  opportunity_id: string | null;
  revenue_path: string;
  rail: "stripe" | "x402";
  reference: string;
  amount_gbp: number;
  settled_at: string;
  test_mode: boolean;
}
export interface PoolEventRow {
  event_id: string;
  at: string;
  kind: "topup" | "adjustment";
  amount_gbp: number;
  approval_id: string | null;
  by: string;
  note: string | null;
}
export interface DecisionLogRow {
  id: string;
  at: string;
  subject: "graph_plan" | "graph_node" | "idea";
  subject_id: string;
  graph_id: string | null;
  graph_version: number | null;
  decision: "reject" | "edit" | "question";
  reason: string;
  by: string;
  decision_id: string | null;
}
export interface GraphShapeRow {
  fingerprint: string;
  first_seen: string;
  live_runs: number;
  met_metric: number;
  breaches: number;
  total_cost_gbp: number;
  autonomy: "L0" | "L1" | "L2" | "L3";
  promoted_playbook: string | null;
  promoted_version: number | null;
  updated_at: string;
}

const toSpec = (r: Row): GraphSpecRow => ({
  graph_id: r.graph_id as string,
  version: Number(r.version),
  parent_version: r.parent_version === null ? null : Number(r.parent_version),
  task_id: r.task_id as string,
  opportunity_id: (r.opportunity_id as string | null) ?? null,
  hypothesis_id: (r.hypothesis_id as string | null) ?? null,
  spec: pj(r.spec),
  content_hash: (r.content_hash as string | null) ?? null,
  registry_version: (r.registry_version as string | null) ?? null,
  compiled: pj(r.compiled),
  lane: (r.lane as GraphSpecRow["lane"]) ?? null,
  worst_case_cost_gbp: r.worst_case_cost_gbp === null ? null : Number(r.worst_case_cost_gbp),
  autonomy: (r.autonomy as GraphSpecRow["autonomy"]) ?? null,
  shape_fingerprint: (r.shape_fingerprint as string | null) ?? null,
  status: r.status as GraphSpecStatus,
  attempt: Number(r.attempt),
  synthetic: bool(r.synthetic),
  created_by: r.created_by as string,
  created_at: r.created_at as string,
});
const toRun = (r: Row): GraphRunRow => ({
  run_id: r.run_id as string,
  graph_id: r.graph_id as string,
  version: Number(r.version),
  instance_id: (r.instance_id as string | null) ?? null,
  mode: r.mode as GraphRunRow["mode"],
  status: r.status as GraphRunRow["status"],
  cost_so_far_gbp: Number(r.cost_so_far_gbp),
  pause_reason: (r.pause_reason as string | null) ?? null,
  started_at: r.started_at as string,
  ended_at: (r.ended_at as string | null) ?? null,
  outcome_id: (r.outcome_id as string | null) ?? null,
  synthetic: bool(r.synthetic),
});
const toCost = (r: Row): CostEventRow => ({
  ...(r as unknown as CostEventRow),
  graph_version: r.graph_version === null ? null : Number(r.graph_version),
  quantity: Number(r.quantity),
  unit_price_gbp: Number(r.unit_price_gbp),
  amount_gbp: Number(r.amount_gbp),
  synthetic: bool(r.synthetic),
  dry_run: bool(r.dry_run),
});
const toRevenue = (r: Row): RevenueEventRow => ({
  ...(r as unknown as RevenueEventRow),
  amount_gbp: Number(r.amount_gbp),
  test_mode: bool(r.test_mode),
});
const toShape = (r: Row): GraphShapeRow => ({
  fingerprint: r.fingerprint as string,
  first_seen: r.first_seen as string,
  live_runs: Number(r.live_runs),
  met_metric: Number(r.met_metric),
  breaches: Number(r.breaches),
  total_cost_gbp: Number(r.total_cost_gbp),
  autonomy: r.autonomy as GraphShapeRow["autonomy"],
  promoted_playbook: (r.promoted_playbook as string | null) ?? null,
  promoted_version: r.promoted_version === null ? null : Number(r.promoted_version),
  updated_at: r.updated_at as string,
});

export function graphStorage(db: SqlDriver) {
  const all = (sql: string, args: SqlValue[] = []) => db.all<Row>(sql, args);
  const insert = async (table: string, row: Record<string, SqlValue>) => {
    const cols = Object.keys(row);
    await db.run(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => row[c] ?? null),
    );
  };
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  const insertStmt = (table: string, row: Record<string, SqlValue>) => {
    const cols = Object.keys(row);
    return {
      sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      params: cols.map((c) => row[c] ?? null),
    };
  };
  /** The daily_rollups upsert that goes in the same batch as its event (data layer plan, step 4). */
  const rollup = (k: {
    day: string;
    revenue_path: string | null;
    playbook: string | null;
    mode: string;
    synthetic: boolean;
    dry_run: boolean;
    cost_gbp?: number;
    revenue_gbp?: number;
    cost_events?: number;
    runs?: number;
  }) => ({
    sql: "INSERT INTO daily_rollups (day, revenue_path, playbook, mode, synthetic, dry_run, cost_gbp, revenue_gbp, cost_events, runs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, revenue_path, playbook, mode, synthetic, dry_run) DO UPDATE SET cost_gbp = cost_gbp + excluded.cost_gbp, revenue_gbp = revenue_gbp + excluded.revenue_gbp, cost_events = cost_events + excluded.cost_events, runs = runs + excluded.runs",
    params: [
      k.day.slice(0, 10),
      k.revenue_path ?? "",
      k.playbook ?? "",
      k.mode,
      k.synthetic ? 1 : 0,
      k.dry_run ? 1 : 0,
      k.cost_gbp ?? 0,
      k.revenue_gbp ?? 0,
      k.cost_events ?? 0,
      k.runs ?? 0,
    ] as SqlValue[],
  });
  const isDayStart = (iso: string) =>
    /T00:00:00(\.0+)?Z$/.test(iso) || /^\d{4}-\d{2}-\d{2}$/.test(iso);

  return {
    graphSpecs: {
      add: async (s: Omit<GraphSpecRow, "created_at">): Promise<void> =>
        insert("graph_specs", {
          ...s,
          spec: JSON.stringify(s.spec),
          compiled: json(s.compiled),
          synthetic: s.synthetic ? 1 : 0,
          created_at: nowIso(),
        } as Record<string, SqlValue>),
      get: async (graphId: string, version: number): Promise<GraphSpecRow | null> => {
        const r = (
          await all("SELECT * FROM graph_specs WHERE graph_id = ? AND version = ?", [
            graphId,
            version,
          ])
        )[0];
        return r ? toSpec(r) : null;
      },
      latest: async (graphId: string): Promise<GraphSpecRow | null> => {
        const r = (
          await all("SELECT * FROM graph_specs WHERE graph_id = ? ORDER BY version DESC LIMIT 1", [
            graphId,
          ])
        )[0];
        return r ? toSpec(r) : null;
      },
      versions: async (graphId: string): Promise<GraphSpecRow[]> =>
        (await all("SELECT * FROM graph_specs WHERE graph_id = ? ORDER BY version", [graphId])).map(
          toSpec,
        ),
      forTask: async (taskId: string): Promise<GraphSpecRow[]> =>
        (
          await all("SELECT * FROM graph_specs WHERE task_id = ? ORDER BY created_at", [taskId])
        ).map(toSpec),
      setCompiled: async (
        graphId: string,
        version: number,
        c: {
          content_hash: string;
          registry_version: string;
          compiled: unknown;
          lane: "open" | "licensed";
          worst_case_cost_gbp: number;
          autonomy: "L0" | "L1" | "L2" | "L3";
          shape_fingerprint: string;
        },
      ): Promise<void> => {
        await db.run(
          "UPDATE graph_specs SET content_hash = ?, registry_version = ?, compiled = ?, lane = ?, worst_case_cost_gbp = ?, autonomy = ?, shape_fingerprint = ? WHERE graph_id = ? AND version = ?",
          [
            c.content_hash,
            c.registry_version,
            JSON.stringify(c.compiled),
            c.lane,
            c.worst_case_cost_gbp,
            c.autonomy,
            c.shape_fingerprint,
            graphId,
            version,
          ],
        );
      },
      setStatus: async (
        graphId: string,
        version: number,
        status: GraphSpecStatus,
      ): Promise<void> => {
        await db.run("UPDATE graph_specs SET status = ? WHERE graph_id = ? AND version = ?", [
          status,
          graphId,
          version,
        ]);
      },
      list: async (o: { status?: GraphSpecStatus; limit?: number } = {}): Promise<GraphSpecRow[]> =>
        (
          await all(
            `SELECT * FROM graph_specs ${o.status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT ?`,
            o.status ? [o.status, o.limit ?? 200] : [o.limit ?? 200],
          )
        ).map(toSpec),
    },

    sandboxReports: {
      add: async (r: {
        id: string;
        graph_id: string;
        version: number;
        attempt: number;
        scenario: string;
        mode: "sandbox" | "probe";
        as_of: string;
        pass: boolean;
        report: unknown;
        sandbox_cost_gbp: number;
        projected_live_cost_gbp: number;
        run_id: string;
      }): Promise<void> =>
        insert("sandbox_reports", {
          ...r,
          pass: r.pass ? 1 : 0,
          report: JSON.stringify(r.report),
          created_at: nowIso(),
        } as Record<string, SqlValue>),
      forGraph: async (graphId: string, version?: number) =>
        (
          await all(
            `SELECT * FROM sandbox_reports WHERE graph_id = ? ${version ? "AND version = ?" : ""} ORDER BY created_at`,
            version ? [graphId, version] : [graphId],
          )
        ).map((r) => ({
          id: r.id as string,
          graph_id: r.graph_id as string,
          version: Number(r.version),
          attempt: Number(r.attempt),
          scenario: r.scenario as string,
          mode: r.mode as "sandbox" | "probe",
          as_of: r.as_of as string,
          pass: bool(r.pass),
          report: pj(r.report),
          sandbox_cost_gbp: Number(r.sandbox_cost_gbp),
          projected_live_cost_gbp: Number(r.projected_live_cost_gbp),
          run_id: r.run_id as string,
          created_at: r.created_at as string,
        })),
    },

    graphRuns: {
      add: async (
        r: Omit<GraphRunRow, "cost_so_far_gbp" | "pause_reason" | "ended_at" | "outcome_id">,
      ) =>
        insert("graph_runs", {
          ...r,
          cost_so_far_gbp: 0,
          synthetic: r.synthetic ? 1 : 0,
        } as Record<string, SqlValue>),
      get: async (runId: string): Promise<GraphRunRow | null> => {
        const r = (await all("SELECT * FROM graph_runs WHERE run_id = ?", [runId]))[0];
        return r ? toRun(r) : null;
      },
      update: async (
        runId: string,
        p: Partial<
          Pick<GraphRunRow, "status" | "instance_id" | "pause_reason" | "ended_at" | "outcome_id">
        >,
      ): Promise<void> => {
        const keys = Object.keys(p) as (keyof typeof p)[];
        if (!keys.length) return;
        const update = {
          sql: `UPDATE graph_runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE run_id = ?`,
          params: [...keys.map((k) => (p[k] ?? null) as SqlValue), runId],
        };
        if (!p.ended_at) return db.batch([update]);
        // A run's end also counts it in daily_rollups, once (only while ended_at is still unset), in
        // the same batch as the update.
        await db.batch([
          {
            sql: "INSERT INTO daily_rollups (day, revenue_path, playbook, mode, synthetic, dry_run, runs) SELECT substr(?, 1, 10), '', graph_id, mode, synthetic, 0, 1 FROM graph_runs WHERE run_id = ? AND ended_at IS NULL ON CONFLICT (day, revenue_path, playbook, mode, synthetic, dry_run) DO UPDATE SET runs = runs + 1",
            params: [p.ended_at, runId],
          },
          update,
        ]);
      },
      addCost: async (runId: string, gbp: number): Promise<void> => {
        await db.run(
          "UPDATE graph_runs SET cost_so_far_gbp = cost_so_far_gbp + ? WHERE run_id = ?",
          [gbp, runId],
        );
      },
      list: async (
        o: { mode?: GraphRunRow["mode"]; limit?: number } = {},
      ): Promise<GraphRunRow[]> =>
        (
          await all(
            `SELECT * FROM graph_runs ${o.mode ? "WHERE mode = ?" : ""} ORDER BY started_at DESC LIMIT ?`,
            o.mode ? [o.mode, o.limit ?? 200] : [o.limit ?? 200],
          )
        ).map(toRun),
    },

    decisionLog: {
      add: async (d: DecisionLogRow): Promise<void> =>
        insert("decision_log", d as unknown as Record<string, SqlValue>),
      forSubject: async (
        subject: DecisionLogRow["subject"],
        subjectId: string,
      ): Promise<DecisionLogRow[]> =>
        (
          await all("SELECT * FROM decision_log WHERE subject = ? AND subject_id = ? ORDER BY at", [
            subject,
            subjectId,
          ])
        ).map((r) => ({
          ...(r as unknown as DecisionLogRow),
          graph_version: r.graph_version === null ? null : Number(r.graph_version),
        })),
      forGraph: async (graphId: string): Promise<DecisionLogRow[]> =>
        (await all("SELECT * FROM decision_log WHERE graph_id = ? ORDER BY at", [graphId])).map(
          (r) => ({
            ...(r as unknown as DecisionLogRow),
            graph_version: r.graph_version === null ? null : Number(r.graph_version),
          }),
        ),
      recent: async (limit = 200): Promise<DecisionLogRow[]> =>
        (await all("SELECT * FROM decision_log ORDER BY at DESC LIMIT ?", [limit])).map((r) => ({
          ...(r as unknown as DecisionLogRow),
          graph_version: r.graph_version === null ? null : Number(r.graph_version),
        })),
    },

    graphShapes: {
      get: async (fp: string): Promise<GraphShapeRow | null> => {
        const r = (await all("SELECT * FROM graph_shapes WHERE fingerprint = ?", [fp]))[0];
        return r ? toShape(r) : null;
      },
      ensure: async (fp: string): Promise<void> => {
        await db.run(
          "INSERT INTO graph_shapes (fingerprint, first_seen, updated_at) VALUES (?, ?, ?) ON CONFLICT (fingerprint) DO NOTHING",
          [fp, nowIso(), nowIso()],
        );
      },
      record: async (
        fp: string,
        d: { met_metric: boolean; breach: boolean; cost_gbp: number },
      ): Promise<void> => {
        await db.run(
          "UPDATE graph_shapes SET live_runs = live_runs + 1, met_metric = met_metric + ?, breaches = breaches + ?, total_cost_gbp = total_cost_gbp + ?, updated_at = ? WHERE fingerprint = ?",
          [d.met_metric ? 1 : 0, d.breach ? 1 : 0, d.cost_gbp, nowIso(), fp],
        );
      },
      setAutonomy: async (fp: string, autonomy: GraphShapeRow["autonomy"]): Promise<void> => {
        await db.run("UPDATE graph_shapes SET autonomy = ?, updated_at = ? WHERE fingerprint = ?", [
          autonomy,
          nowIso(),
          fp,
        ]);
      },
      setPromoted: async (fp: string, name: string, version: number): Promise<void> => {
        await db.run(
          "UPDATE graph_shapes SET promoted_playbook = ?, promoted_version = ?, updated_at = ? WHERE fingerprint = ?",
          [name, version, nowIso(), fp],
        );
      },
      list: async (): Promise<GraphShapeRow[]> =>
        (await all("SELECT * FROM graph_shapes ORDER BY updated_at DESC")).map(toShape),
    },

    promotedPlaybooks: {
      add: async (p: {
        name: string;
        version: number;
        fingerprint: string;
        spec: unknown;
        skill_md: string;
        autonomy: "L0" | "L1" | "L2" | "L3";
        approval_id: string;
      }): Promise<void> =>
        insert("promoted_playbooks", {
          ...p,
          spec: JSON.stringify(p.spec),
          created_at: nowIso(),
        } as Record<string, SqlValue>),
      get: async (name: string, version: number) => {
        const r = (
          await all("SELECT * FROM promoted_playbooks WHERE name = ? AND version = ?", [
            name,
            version,
          ])
        )[0];
        return r ? { ...r, version: Number(r.version), spec: pj(r.spec) } : null;
      },
      list: async () =>
        (await all("SELECT * FROM promoted_playbooks ORDER BY name, version")).map((r) => ({
          name: r.name as string,
          version: Number(r.version),
          fingerprint: r.fingerprint as string,
          autonomy: r.autonomy as "L0" | "L1" | "L2" | "L3",
          approval_id: r.approval_id as string,
          created_at: r.created_at as string,
        })),
    },

    costEvents: {
      /** The event and its daily rollup in ONE batch: they can never disagree. */
      add: async (e: CostEventRow): Promise<void> =>
        db.batch([
          insertStmt("cost_events", {
            ...e,
            playbook: e.playbook ?? null,
            step_id: e.step_id ?? null,
            synthetic: e.synthetic ? 1 : 0,
            dry_run: e.dry_run ? 1 : 0,
          } as unknown as Record<string, SqlValue>),
          rollup({
            day: e.at,
            revenue_path: e.revenue_path,
            playbook: e.playbook ?? null,
            mode: e.mode,
            synthetic: e.synthetic,
            dry_run: e.dry_run,
            cost_gbp: e.amount_gbp,
            cost_events: 1,
          }),
        ]),
      /**
       * Spend since `since` that counts against the caps: mode "live" and not dry-run (a simulated paid
       * action costs nothing). Synthetic rows count, as they always have, so caps still bite in simulated
       * worlds; real-money views exclude them themselves. Optionally one playbook, leaving out steps.
       *
       * From a day boundary (the caps, the digest, Budgets) it reads daily_rollups: a few rows, never
       * cached, so the tracker is exact the moment an event is written. Excluded steps (printing and
       * postage) are taken off from their own events, a small indexed read. Any other `since` sums the
       * events directly.
       */
      spendSince: async (
        since: string,
        o: { playbook?: string; excludeSteps?: string[] } = {},
      ): Promise<number> => {
        const ex = o.excludeSteps ?? [];
        const sum = async (sql: string, args: SqlValue[]) =>
          Number((await all(sql, args))[0]?.s ?? 0);
        if (isDayStart(since)) {
          const where = ["day >= ?", "mode = 'live'", "dry_run = 0"];
          const args: SqlValue[] = [since.slice(0, 10)];
          if (o.playbook) {
            where.push("playbook = ?");
            args.push(o.playbook);
          }
          const total = await sum(
            `SELECT COALESCE(SUM(cost_gbp), 0) AS s FROM daily_rollups WHERE ${where.join(" AND ")}`,
            args,
          );
          if (!ex.length) return total;
          const exWhere = [
            "at >= ?",
            "mode = 'live'",
            "dry_run = 0",
            `step_id IN (${ex.map(() => "?").join(", ")})`,
          ];
          const exArgs: SqlValue[] = [since.slice(0, 10), ...ex];
          if (o.playbook) {
            exWhere.push("playbook = ?");
            exArgs.push(o.playbook);
          }
          return (
            total -
            (await sum(
              `SELECT COALESCE(SUM(amount_gbp), 0) AS s FROM cost_events WHERE ${exWhere.join(" AND ")}`,
              exArgs,
            ))
          );
        }
        const where = ["at >= ?", "mode = 'live'", "dry_run = 0"];
        const args: SqlValue[] = [since];
        if (o.playbook) {
          where.push("playbook = ?");
          args.push(o.playbook);
        }
        if (ex.length) {
          where.push(`(step_id IS NULL OR step_id NOT IN (${ex.map(() => "?").join(", ")}))`);
          args.push(...ex);
        }
        return sum(
          `SELECT COALESCE(SUM(amount_gbp), 0) AS s FROM cost_events WHERE ${where.join(" AND ")}`,
          args,
        );
      },
      forRun: async (runId: string): Promise<CostEventRow[]> =>
        (
          await all("SELECT * FROM cost_events WHERE run_id = ? ORDER BY at, event_id", [runId])
        ).map(toCost),
      range: async (o: {
        from: string;
        to: string;
        modes?: CostEventRow["mode"][];
      }): Promise<CostEventRow[]> => {
        const where = ["at >= ?", "at < ?"];
        const args: SqlValue[] = [o.from, o.to];
        if (o.modes?.length) {
          where.push(`mode IN (${o.modes.map(() => "?").join(", ")})`);
          args.push(...o.modes);
        }
        return (
          await all(`SELECT * FROM cost_events WHERE ${where.join(" AND ")} ORDER BY at`, args)
        ).map(toCost);
      },
      /** Sum by mode, in code-friendly rows (roll-ups are computed in TypeScript over these). */
      totals: async (o: { from: string; to: string }) =>
        (
          await all(
            "SELECT mode, SUM(amount_gbp) AS gbp, COUNT(*) AS n FROM cost_events WHERE at >= ? AND at < ? GROUP BY mode",
            [o.from, o.to],
          )
        ).map((r) => ({
          mode: r.mode as CostEventRow["mode"],
          gbp: Number(r.gbp),
          n: Number(r.n),
        })),
    },

    dailyRollups: {
      /** Rollup rows for days in [from, to) (YYYY-MM-DD or ISO), for the cost tracker and Budgets. */
      range: async (o: { from: string; to: string }): Promise<DailyRollupRow[]> =>
        (
          await all(
            "SELECT * FROM daily_rollups WHERE day >= ? AND day < ? ORDER BY day, revenue_path, playbook, mode",
            [o.from.slice(0, 10), o.to.slice(0, 10)],
          )
        ).map((r) => ({
          day: r.day as string,
          revenue_path: r.revenue_path as string,
          playbook: r.playbook as string,
          mode: r.mode as DailyRollupRow["mode"],
          synthetic: Number(r.synthetic) === 1,
          dry_run: Number(r.dry_run) === 1,
          cost_gbp: Number(r.cost_gbp),
          revenue_gbp: Number(r.revenue_gbp),
          cost_events: Number(r.cost_events),
          runs: Number(r.runs),
        })),
    },

    revenueEvents: {
      /** The event and its daily rollup in ONE batch (Stripe test-mode money counts as dry run). */
      add: async (e: RevenueEventRow): Promise<void> =>
        db.batch([
          insertStmt("revenue_events", {
            ...e,
            test_mode: e.test_mode ? 1 : 0,
          } as unknown as Record<string, SqlValue>),
          rollup({
            day: e.settled_at,
            revenue_path: e.revenue_path,
            playbook: null,
            mode: "live",
            synthetic: false,
            dry_run: e.test_mode,
            revenue_gbp: e.amount_gbp,
          }),
        ]),
      range: async (o: { from: string; to: string }): Promise<RevenueEventRow[]> =>
        (
          await all(
            "SELECT * FROM revenue_events WHERE settled_at >= ? AND settled_at < ? ORDER BY settled_at",
            [o.from, o.to],
          )
        ).map(toRevenue),
    },

    poolEvents: {
      add: async (e: PoolEventRow): Promise<void> =>
        insert("pool_events", e as unknown as Record<string, SqlValue>),
      list: async (): Promise<PoolEventRow[]> =>
        (await all("SELECT * FROM pool_events ORDER BY at")).map((r) => ({
          ...(r as unknown as PoolEventRow),
          amount_gbp: Number(r.amount_gbp),
        })),
    },
  };
}

export type GraphStorage = ReturnType<typeof graphStorage>;
