import { Opportunity, RunLogEntry, Task } from "@ae/contracts";
import type { SqlDriver, SqlValue } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const j = (v: unknown) => JSON.stringify(v);
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));

export interface StoredOpportunity extends Opportunity {
  decided_at: string | null;
  rank: number;
  rationale: string | null;
  run_id: string;
  created_at: string;
}

export interface StoredTask extends Task {
  priority: string;
  state: Record<string, unknown>;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredRunLog extends RunLogEntry {
  id: number;
}

export interface AlertRow {
  id: number;
  kind: string;
  message: string;
  details: unknown;
  created_at: string;
  acknowledged_at: string | null;
}

export interface QuarantineRow {
  id: string;
  source: string;
  raw_ref: string;
  record: unknown;
  candidates: unknown;
  reason: string;
  created_at: string;
  resolved_entity_id: string | null;
  resolved_at: string | null;
}

function rowToOpp(r: Row): StoredOpportunity {
  const o = Opportunity.parse({
    opportunity_id: r.opportunity_id,
    module: r.module,
    module_version: r.module_version,
    note_hash: r.note_hash,
    entity_id: r.entity_id,
    as_of: r.as_of,
    score: r.score,
    expected_value_gbp: r.expected_value_gbp,
    confidence: r.confidence,
    trace: pj(r.trace),
    lane: r.lane,
    explore: Number(r.explore) === 1,
    status: r.status,
  });
  return {
    ...o,
    decided_at: (r.decided_at as string | null) ?? null,
    rank: Number(r.rank),
    rationale: (r.rationale as string | null) ?? null,
    run_id: r.run_id as string,
    created_at: r.created_at as string,
  };
}

function rowToTask(r: Row): StoredTask {
  const t = Task.parse({
    task_id: r.task_id,
    idempotency_key: r.idempotency_key,
    playbook: r.playbook,
    playbook_version: r.playbook_version,
    revenue_path: r.revenue_path,
    source_ref: r.source_ref,
    lane: r.lane,
    autonomy: r.autonomy,
    status: r.status,
    budget_gbp: r.budget_gbp,
    revenue_gbp: r.revenue_gbp,
    cost_gbp: r.cost_gbp,
  });
  return {
    ...t,
    priority: r.priority as string,
    state: pj(r.state) ?? {},
    error: (r.error as string | null) ?? null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
  };
}

function rowToRunLog(r: Row): StoredRunLog {
  const e = RunLogEntry.parse({
    task_id: r.task_id,
    step_id: r.step_id,
    role: r.role,
    model: r.model ?? null,
    tool_calls: pj(r.tool_calls),
    output: pj(r.output),
    check_result: pj(r.check_result),
    tokens: { input: Number(r.tokens_in), output: Number(r.tokens_out) },
    cost_gbp: r.cost_gbp,
    duration_ms: Number(r.duration_ms),
    timestamp: r.timestamp,
  });
  return { ...e, id: Number(r.id) };
}

/** Phase 2 storage namespaces (opportunity engine + agent infrastructure). */
export function phase2(db: SqlDriver) {
  return {
    signals: {
      putMany: async (
        rows: {
          signal_id: string;
          signal_version: number;
          entity_id: string;
          as_of: string;
          value: number | null;
          fact_ids: string[];
        }[],
        runId: string,
      ) => {
        const chunks: (typeof rows)[] = [];
        for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
        for (const c of chunks) {
          await db.batch(
            c.map((s) => ({
              sql: "INSERT OR REPLACE INTO signal_values (signal_id, signal_version, entity_id, as_of, value, fact_ids, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
              params: [
                s.signal_id,
                s.signal_version,
                s.entity_id,
                s.as_of,
                s.value,
                j(s.fact_ids),
                runId,
              ],
            })),
          );
        }
      },
      list: async (entityId: string, asOf: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM signal_values WHERE entity_id = ? AND as_of = ? ORDER BY signal_id",
            [entityId, asOf],
          )
        ).map((r) => ({
          signal_id: r.signal_id as string,
          signal_version: Number(r.signal_version),
          value: r.value === null ? null : Number(r.value),
          fact_ids: pj(r.fact_ids) as string[],
        })),
    },

    moduleRuns: {
      put: async (m: {
        run_id: string;
        module: string;
        module_version: number;
        note_hash: string;
        as_of: string;
        mode: "reconstructed" | "strict";
        candidates: number;
        above_threshold: number;
        explore: number;
      }) => {
        await db.run(
          "INSERT INTO module_runs (run_id, module, module_version, note_hash, as_of, mode, candidates, above_threshold, explore, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            m.run_id,
            m.module,
            m.module_version,
            m.note_hash,
            m.as_of,
            m.mode,
            m.candidates,
            m.above_threshold,
            m.explore,
            nowIso(),
          ],
        );
      },
      latest: async (module: string) => {
        const r = (
          await db.all<Row>(
            "SELECT * FROM module_runs WHERE module = ? ORDER BY created_at DESC LIMIT 1",
            [module],
          )
        )[0];
        return r ?? null;
      },
    },

    opportunities: {
      putMany: async (
        opps: (Opportunity & { rank: number; rationale?: string | null })[],
        runId: string,
      ) => {
        const at = nowIso();
        for (let i = 0; i < opps.length; i += 100) {
          await db.batch(
            opps.slice(i, i + 100).map((input) => {
              const o = Opportunity.parse(input);
              return {
                sql: `INSERT INTO opportunities (opportunity_id, module, module_version, note_hash, entity_id, as_of, score, expected_value_gbp, confidence, trace, lane, explore, status, rank, rationale, run_id, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                params: [
                  o.opportunity_id,
                  o.module,
                  o.module_version,
                  o.note_hash,
                  o.entity_id,
                  o.as_of,
                  o.score,
                  o.expected_value_gbp,
                  o.confidence,
                  j(o.trace),
                  o.lane,
                  o.explore ? 1 : 0,
                  o.status,
                  input.rank,
                  input.rationale ?? null,
                  runId,
                  at,
                ] as SqlValue[],
              };
            }),
          );
        }
      },
      get: async (id: string) => {
        const r = (
          await db.all<Row>("SELECT * FROM opportunities WHERE opportunity_id = ?", [id])
        )[0];
        return r ? rowToOpp(r) : null;
      },
      list: async (q: {
        status?: string;
        module?: string;
        runId?: string;
        entityId?: string;
        limit: number;
        offset?: number;
      }) => {
        const w: string[] = [];
        const p: SqlValue[] = [];
        if (q.status) {
          w.push("status = ?");
          p.push(q.status);
        }
        if (q.module) {
          w.push("module = ?");
          p.push(q.module);
        }
        if (q.runId) {
          w.push("run_id = ?");
          p.push(q.runId);
        }
        if (q.entityId) {
          w.push("entity_id = ?");
          p.push(q.entityId);
        }
        const rows = await db.all<Row>(
          `SELECT * FROM opportunities ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY created_at DESC, rank LIMIT ? OFFSET ?`,
          [...p, q.limit, q.offset ?? 0],
        );
        return rows.map(rowToOpp);
      },
      setStatus: async (id: string, status: Opportunity["status"]) => {
        const r = await db.run(
          "UPDATE opportunities SET status = ?, decided_at = ? WHERE opportunity_id = ?",
          [status, nowIso(), id],
        );
        if (r.changes !== 1) throw new Error(`opportunity ${id} not found`);
      },
      setRationale: async (id: string, rationale: string) => {
        await db.run("UPDATE opportunities SET rationale = ? WHERE opportunity_id = ?", [
          rationale,
          id,
        ]);
      },
    },

    tasks: {
      /** Insert unless the idempotency key exists; returns the stored task either way. */
      insertIdempotent: async (t: Task & { priority: string; state?: Record<string, unknown> }) => {
        const v = Task.parse(t);
        const at = nowIso();
        await db.run(
          `INSERT OR IGNORE INTO tasks (task_id, idempotency_key, playbook, playbook_version, revenue_path, source_ref, lane, autonomy, status, budget_gbp, revenue_gbp, cost_gbp, priority, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            v.task_id,
            v.idempotency_key,
            v.playbook,
            v.playbook_version,
            v.revenue_path,
            v.source_ref,
            v.lane,
            v.autonomy,
            v.status,
            v.budget_gbp,
            v.revenue_gbp,
            v.cost_gbp,
            t.priority,
            j(t.state ?? {}),
            at,
            at,
          ],
        );
        const r = (
          await db.all<Row>("SELECT * FROM tasks WHERE idempotency_key = ?", [v.idempotency_key])
        )[0];
        return rowToTask(r as Row);
      },
      get: async (id: string) => {
        const r = (await db.all<Row>("SELECT * FROM tasks WHERE task_id = ?", [id]))[0];
        return r ? rowToTask(r) : null;
      },
      /** Tasks about one company (source_ref ends ":entity:<number>"), newest first. */
      forEntity: async (entityId: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM tasks WHERE source_ref LIKE ? ORDER BY created_at DESC LIMIT 200",
            [`%:entity:${entityId}`],
          )
        ).map(rowToTask),
      update: async (
        id: string,
        patch: Partial<
          Pick<StoredTask, "status" | "cost_gbp" | "revenue_gbp" | "state" | "error" | "autonomy">
        >,
      ) => {
        const sets: string[] = [];
        const p: SqlValue[] = [];
        for (const [k, v] of Object.entries(patch)) {
          sets.push(`${k} = ?`);
          p.push(k === "state" ? j(v) : (v as SqlValue));
        }
        sets.push("updated_at = ?");
        p.push(nowIso());
        await db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`, [...p, id]);
      },
      addCost: async (id: string, gbp: number) => {
        await db.run("UPDATE tasks SET cost_gbp = cost_gbp + ?, updated_at = ? WHERE task_id = ?", [
          gbp,
          nowIso(),
          id,
        ]);
      },
      addRevenue: async (id: string, gbp: number) => {
        await db.run(
          "UPDATE tasks SET revenue_gbp = revenue_gbp + ?, updated_at = ? WHERE task_id = ?",
          [gbp, nowIso(), id],
        );
      },
      list: async (q: {
        status?: string;
        playbook?: string;
        limit: number;
        offset?: number;
        order?: "asc" | "desc";
      }) => {
        const w: string[] = [];
        const p: SqlValue[] = [];
        if (q.status) {
          w.push("status = ?");
          p.push(q.status);
        }
        if (q.playbook) {
          w.push("playbook = ?");
          p.push(q.playbook);
        }
        const rows = await db.all<Row>(
          `SELECT * FROM tasks ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY created_at ${q.order === "asc" ? "ASC" : "DESC"}, task_id LIMIT ? OFFSET ?`,
          [...p, q.limit, q.offset ?? 0],
        );
        return rows.map(rowToTask);
      },
      /** Tasks stuck in `running` since before `cutoff` (for timeouts). */
      stuck: async (cutoff: string) =>
        (
          await db.all<Row>("SELECT * FROM tasks WHERE status = 'running' AND updated_at < ?", [
            cutoff,
          ])
        ).map(rowToTask),
    },

    runLog: {
      append: async (e: RunLogEntry) => {
        const v = RunLogEntry.parse(e);
        await db.run(
          `INSERT INTO run_log (task_id, step_id, role, model, tool_calls, output, check_result, tokens_in, tokens_out, cost_gbp, duration_ms, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            v.task_id,
            v.step_id,
            v.role,
            v.model,
            j(v.tool_calls),
            j(v.output),
            v.check_result === null ? null : j(v.check_result),
            v.tokens.input,
            v.tokens.output,
            v.cost_gbp,
            v.duration_ms,
            v.timestamp,
          ],
        );
      },
      forTask: async (taskId: string) =>
        (await db.all<Row>("SELECT * FROM run_log WHERE task_id = ? ORDER BY id", [taskId])).map(
          rowToRunLog,
        ),
      /** Spend in GBP since `since`, optionally for one playbook, leaving out the given step ids. */
      spendSince: async (since: string, playbook?: string, excludeSteps: string[] = []) => {
        const ex = excludeSteps.length
          ? ` AND r.step_id NOT IN (${excludeSteps.map(() => "?").join(", ")})`
          : "";
        const rows = await db.all<{ s: number }>(
          playbook
            ? `SELECT COALESCE(SUM(r.cost_gbp), 0) AS s FROM run_log r JOIN tasks t ON t.task_id = r.task_id WHERE r.timestamp >= ? AND t.playbook = ?${ex}`
            : `SELECT COALESCE(SUM(r.cost_gbp), 0) AS s FROM run_log r WHERE r.timestamp >= ?${ex}`,
          playbook ? [since, playbook, ...excludeSteps] : [since, ...excludeSteps],
        );
        return Number(rows[0]?.s ?? 0);
      },
    },

    approvals: {
      add: async (a: {
        task_id: string;
        step_id: string;
        item_shown: unknown;
        decision: "approve" | "edit" | "reject";
        edited_text: string | null;
      }) => {
        await db.run(
          "INSERT INTO approvals (task_id, step_id, item_shown, decision, edited_text, decided_at) VALUES (?, ?, ?, ?, ?, ?)",
          [a.task_id, a.step_id, j(a.item_shown), a.decision, a.edited_text, nowIso()],
        );
      },
      forTask: async (taskId: string) =>
        (await db.all<Row>("SELECT * FROM approvals WHERE task_id = ? ORDER BY id", [taskId])).map(
          (r) => ({
            task_id: r.task_id as string,
            step_id: r.step_id as string,
            item_shown: pj(r.item_shown),
            decision: r.decision as "approve" | "edit" | "reject",
            edited_text: (r.edited_text as string | null) ?? null,
            decided_at: r.decided_at as string,
          }),
        ),
    },

    examples: {
      add: async (e: {
        playbook: string;
        step_id: string;
        task_id: string;
        original: string;
        edited: string;
      }) => {
        await db.run(
          "INSERT INTO playbook_examples (playbook, step_id, task_id, original, edited, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [e.playbook, e.step_id, e.task_id, e.original, e.edited, nowIso()],
        );
      },
      list: async (playbook: string, stepId: string, limit: number) =>
        (
          await db.all<Row>(
            "SELECT * FROM playbook_examples WHERE playbook = ? AND step_id = ? ORDER BY id DESC LIMIT ?",
            [playbook, stepId, limit],
          )
        ).map((r) => ({
          original: r.original as string,
          edited: r.edited as string,
          task_id: r.task_id as string,
        })),
    },

    controls: {
      get: async <T>(key: string): Promise<T | null> => {
        const r = (await db.all<Row>("SELECT value FROM controls WHERE key = ?", [key]))[0];
        return r ? (JSON.parse(r.value as string) as T) : null;
      },
      set: async (key: string, value: unknown, by: string) => {
        await db.run(
          "INSERT INTO controls (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
          [key, j(value), nowIso(), by],
        );
      },
      all: async () =>
        Object.fromEntries(
          (await db.all<Row>("SELECT key, value FROM controls ORDER BY key")).map((r) => [
            r.key as string,
            JSON.parse(r.value as string),
          ]),
        ),
    },

    alerts: {
      raise: async (kind: string, message: string, details: unknown = {}) => {
        await db.run(
          "INSERT INTO alerts (kind, message, details, created_at) VALUES (?, ?, ?, ?)",
          [kind, message, j(details), nowIso()],
        );
      },
      list: async (opts: { unacknowledged?: boolean; limit: number }) =>
        (
          await db.all<Row>(
            `SELECT * FROM alerts ${opts.unacknowledged ? "WHERE acknowledged_at IS NULL" : ""} ORDER BY id DESC LIMIT ?`,
            [opts.limit],
          )
        ).map(
          (r): AlertRow => ({
            id: Number(r.id),
            kind: r.kind as string,
            message: r.message as string,
            details: pj(r.details),
            created_at: r.created_at as string,
            acknowledged_at: (r.acknowledged_at as string | null) ?? null,
          }),
        ),
      acknowledge: async (id: number) => {
        await db.run("UPDATE alerts SET acknowledged_at = ? WHERE id = ?", [nowIso(), id]);
      },
    },

    quarantine: {
      add: async (q: {
        source: string;
        raw_ref: string;
        record: unknown;
        candidates: unknown;
        reason: string;
      }) => {
        const id = crypto.randomUUID();
        await db.run(
          "INSERT INTO quarantined_matches (id, source, raw_ref, record, candidates, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [id, q.source, q.raw_ref, j(q.record), j(q.candidates), q.reason, nowIso()],
        );
        return id;
      },
      listOpen: async (limit: number) =>
        (
          await db.all<Row>(
            "SELECT * FROM quarantined_matches WHERE resolved_at IS NULL ORDER BY created_at LIMIT ?",
            [limit],
          )
        ).map(
          (r): QuarantineRow => ({
            id: r.id as string,
            source: r.source as string,
            raw_ref: r.raw_ref as string,
            record: pj(r.record),
            candidates: pj(r.candidates),
            reason: r.reason as string,
            created_at: r.created_at as string,
            resolved_entity_id: null,
            resolved_at: null,
          }),
        ),
      resolve: async (id: string, entityId: string | null) => {
        await db.run(
          "UPDATE quarantined_matches SET resolved_entity_id = ?, resolved_at = ? WHERE id = ?",
          [entityId, nowIso(), id],
        );
      },
    },
  };
}

export type Phase2Storage = ReturnType<typeof phase2>;
