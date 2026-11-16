import type { SqlDriver, SqlValue } from "./driver.ts";

/**
 * v2 Phase 2 storage: recorded external effects, workflow instances and steps, dead letters, trigger
 * statistics and runtime heartbeats.
 */
type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));
const first = async (db: SqlDriver, sql: string, params: SqlValue[] = []) =>
  (await db.all<Row>(sql, params))[0] ?? null;

export type EffectStatus = "started" | "done" | "unknown" | "not_happened";
export interface EffectRow {
  key: string;
  task_id: string;
  tool: string;
  dry_run: boolean;
  status: EffectStatus;
  result: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}
const toEffect = (r: Row): EffectRow => ({
  key: r.key as string,
  task_id: r.task_id as string,
  tool: r.tool as string,
  dry_run: Number(r.dry_run) === 1,
  status: r.status as EffectStatus,
  result: pj(r.result),
  error: (r.error as string | null) ?? null,
  started_at: r.started_at as string,
  finished_at: (r.finished_at as string | null) ?? null,
});

export type WorkflowStatus = "running" | "paused" | "sleeping" | "complete" | "errored";
export interface WorkflowInstanceRow {
  id: string;
  workflow: string;
  playbook: string | null;
  params: unknown;
  status: WorkflowStatus;
  dry_run: boolean;
  wake_at: string | null;
  pause_reason: string | null;
  error: string | null;
  output: unknown;
  steps_done: number;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
}
const toInstance = (r: Row): WorkflowInstanceRow => ({
  id: r.id as string,
  workflow: r.workflow as string,
  playbook: (r.playbook as string | null) ?? null,
  params: pj(r.params),
  status: r.status as WorkflowStatus,
  dry_run: Number(r.dry_run) === 1,
  wake_at: (r.wake_at as string | null) ?? null,
  pause_reason: (r.pause_reason as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  output: pj(r.output),
  steps_done: Number(r.steps_done),
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

export interface DeadLetterRow {
  id: string;
  queue: string;
  body: unknown;
  attempts: number;
  error: string | null;
  received_at: string;
  resolved_at: string | null;
}

export interface TriggerStatRow {
  day: string;
  rule_id: string;
  seen: number;
  matched: number;
  acted: number;
  model_calls: number;
}

export function runtimeStorage(db: SqlDriver) {
  return {
    effects: {
      get: async (key: string) => {
        const r = await first(db, "SELECT * FROM external_effects WHERE key = ?", [key]);
        return r ? toEffect(r) : null;
      },
      /** Records the call before it runs. False if a record already exists (the caller must not run it). */
      start: async (e: { key: string; task_id: string; tool: string; dry_run: boolean }) => {
        const before = await first(db, "SELECT key FROM external_effects WHERE key = ?", [e.key]);
        if (before) return false;
        await db.run(
          "INSERT OR IGNORE INTO external_effects (key, task_id, tool, dry_run, status, started_at) VALUES (?, ?, ?, ?, 'started', ?)",
          [e.key, e.task_id, e.tool, e.dry_run ? 1 : 0, nowIso()],
        );
        return true;
      },
      finish: async (
        key: string,
        status: Exclude<EffectStatus, "started">,
        result: unknown,
        error: string | null = null,
      ) => {
        await db.run(
          "UPDATE external_effects SET status = ?, result = ?, error = ?, finished_at = ? WHERE key = ?",
          [status, j(result), error, nowIso(), key],
        );
      },
      /** Effects whose outcome nobody knows (a crash between start and finish, or an error). */
      unresolved: async (limit = 100) =>
        (
          await db.all<Row>(
            "SELECT * FROM external_effects WHERE status IN ('started', 'unknown') ORDER BY started_at DESC LIMIT ?",
            [limit],
          )
        ).map(toEffect),
      forTask: async (taskId: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM external_effects WHERE task_id = ? ORDER BY started_at",
            [taskId],
          )
        ).map(toEffect),
    },

    workflows: {
      create: async (w: {
        id: string;
        workflow: string;
        playbook: string | null;
        params: unknown;
        dry_run: boolean;
        synthetic?: boolean;
      }) => {
        const at = nowIso();
        await db.run(
          "INSERT OR IGNORE INTO workflow_instances (id, workflow, playbook, params, status, dry_run, synthetic, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
          [
            w.id,
            w.workflow,
            w.playbook,
            j(w.params),
            w.dry_run ? 1 : 0,
            w.synthetic ? 1 : 0,
            at,
            at,
          ],
        );
      },
      get: async (id: string) => {
        const r = await first(db, "SELECT * FROM workflow_instances WHERE id = ?", [id]);
        return r ? toInstance(r) : null;
      },
      update: async (
        id: string,
        p: Partial<
          Pick<WorkflowInstanceRow, "status" | "wake_at" | "pause_reason" | "error" | "output">
        >,
      ) => {
        const sets: string[] = ["updated_at = ?"];
        const args: SqlValue[] = [nowIso()];
        for (const [k, v] of Object.entries(p)) {
          sets.push(`${k} = ?`);
          args.push(k === "output" ? j(v) : ((v ?? null) as SqlValue));
        }
        await db.run(`UPDATE workflow_instances SET ${sets.join(", ")} WHERE id = ?`, [
          ...args,
          id,
        ]);
      },
      list: async (o: { status?: WorkflowStatus; limit?: number } = {}) =>
        (
          await db.all<Row>(
            `SELECT * FROM workflow_instances ${o.status ? "WHERE status = ?" : ""} ORDER BY updated_at DESC LIMIT ?`,
            o.status ? [o.status, o.limit ?? 100] : [o.limit ?? 100],
          )
        ).map(toInstance),
      /** Sleeping instances whose wake time has come, and paused ones (resumed when allowed). */
      due: async (nowIsoStr: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM workflow_instances WHERE (status = 'sleeping' AND wake_at <= ?) OR status = 'paused' ORDER BY updated_at LIMIT 100",
            [nowIsoStr],
          )
        ).map(toInstance),
      counts: async () =>
        Object.fromEntries(
          (
            await db.all<Row>(
              "SELECT status, COUNT(*) AS n FROM workflow_instances GROUP BY status",
            )
          ).map((r) => [r.status as string, Number(r.n)]),
        ) as Partial<Record<WorkflowStatus, number>>,
      step: async (instanceId: string, name: string) => {
        const r = await first(
          db,
          "SELECT output FROM workflow_steps WHERE instance_id = ? AND name = ?",
          [instanceId, name],
        );
        return r ? { output: pj(r.output) } : null;
      },
      putStep: async (instanceId: string, name: string, output: unknown) => {
        await db.run(
          "INSERT OR IGNORE INTO workflow_steps (instance_id, name, output, completed_at) VALUES (?, ?, ?, ?)",
          [instanceId, name, j(output) ?? "null", nowIso()],
        );
        await db.run(
          "UPDATE workflow_instances SET steps_done = (SELECT COUNT(*) FROM workflow_steps WHERE instance_id = ?), updated_at = ? WHERE id = ?",
          [instanceId, nowIso(), instanceId],
        );
      },
    },

    deadLetters: {
      add: async (d: { queue: string; body: unknown; attempts: number; error: string | null }) => {
        const id = crypto.randomUUID();
        await db.run(
          "INSERT INTO dead_letters (id, queue, body, attempts, error, received_at) VALUES (?, ?, ?, ?, ?, ?)",
          [id, d.queue, j(d.body), d.attempts, d.error, nowIso()],
        );
        return id;
      },
      list: async (o: { open?: boolean; limit?: number } = {}) =>
        (
          await db.all<Row>(
            `SELECT * FROM dead_letters ${o.open ? "WHERE resolved_at IS NULL" : ""} ORDER BY received_at DESC LIMIT ?`,
            [o.limit ?? 50],
          )
        ).map(
          (r): DeadLetterRow => ({
            id: r.id as string,
            queue: r.queue as string,
            body: pj(r.body),
            attempts: Number(r.attempts),
            error: (r.error as string | null) ?? null,
            received_at: r.received_at as string,
            resolved_at: (r.resolved_at as string | null) ?? null,
          }),
        ),
      resolve: async (id: string) => {
        await db.run("UPDATE dead_letters SET resolved_at = ? WHERE id = ?", [nowIso(), id]);
      },
      openCount: async () =>
        Number(
          (await first(db, "SELECT COUNT(*) AS n FROM dead_letters WHERE resolved_at IS NULL"))
            ?.n ?? 0,
        ),
    },

    triggerStats: {
      bump: async (
        day: string,
        ruleId: string,
        d: { seen?: number; matched?: number; acted?: number; model_calls?: number },
      ) => {
        await db.run(
          `INSERT INTO trigger_stats (day, rule_id, seen, matched, acted, model_calls) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (day, rule_id) DO UPDATE SET seen = seen + excluded.seen, matched = matched + excluded.matched,
             acted = acted + excluded.acted, model_calls = model_calls + excluded.model_calls`,
          [day, ruleId, d.seen ?? 0, d.matched ?? 0, d.acted ?? 0, d.model_calls ?? 0],
        );
      },
      since: async (day: string) =>
        (
          await db.all<Row>(
            "SELECT rule_id, SUM(seen) AS seen, SUM(matched) AS matched, SUM(acted) AS acted, SUM(model_calls) AS model_calls FROM trigger_stats WHERE day >= ? GROUP BY rule_id ORDER BY rule_id",
            [day],
          )
        ).map(
          (r): Omit<TriggerStatRow, "day"> => ({
            rule_id: r.rule_id as string,
            seen: Number(r.seen),
            matched: Number(r.matched),
            acted: Number(r.acted),
            model_calls: Number(r.model_calls),
          }),
        ),
    },

    runtimeStatus: {
      beat: async (name: string, detail: unknown = null, at: string = nowIso()) => {
        await db.run(
          "INSERT INTO runtime_status (name, at, detail) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at, detail = excluded.detail",
          [name, at, j(detail)],
        );
      },
      all: async () =>
        (await db.all<Row>("SELECT * FROM runtime_status ORDER BY name")).map((r) => ({
          name: r.name as string,
          at: r.at as string,
          detail: pj(r.detail),
        })),
    },
  };
}

export type RuntimeStorage = ReturnType<typeof runtimeStorage>;
