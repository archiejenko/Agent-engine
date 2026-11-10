import type { SqlDriver, SqlValue } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));

export interface OutcomeRow {
  id: number;
  opportunity_id: string | null;
  entity_id: string;
  module: string | null;
  event: string;
  value_bool: boolean | null;
  value_gbp: number | null;
  observed_at: string;
  source: "human" | "system" | "verified_fact";
}

export interface DriftRow {
  day: string;
  source: string;
  field: string;
  volume: number;
  null_rate: number;
  mean: number | null;
  top_share: number | null;
  match_rate: number;
}

export interface BacktestRow {
  id: string;
  module: string;
  module_version: number;
  note_hash: string;
  as_of: string;
  mode: string;
  window_days: number;
  candidates: number;
  precision_at_20: number;
  base_rate: number;
  lift: number;
  revenue_lift: number | null;
  calibration: unknown;
  created_at: string;
}

export interface SuggestionRow {
  id: string;
  module: string;
  module_version: number;
  current_weights: Record<string, number>;
  suggested_weights: Record<string, number>;
  evidence: unknown;
  status: "pending" | "accepted" | "rejected";
  created_at: string;
}

const toOutcome = (r: Row): OutcomeRow => ({
  id: Number(r.id),
  opportunity_id: (r.opportunity_id as string | null) ?? null,
  entity_id: r.entity_id as string,
  module: (r.module as string | null) ?? null,
  event: r.event as string,
  value_bool: r.value_bool === null ? null : Number(r.value_bool) === 1,
  value_gbp: r.value_gbp === null ? null : Number(r.value_gbp),
  observed_at: r.observed_at as string,
  source: r.source as OutcomeRow["source"],
});

/** Phase 3 storage namespaces (measurement and outcomes). */
export function phase3(db: SqlDriver) {
  return {
    golden: {
      add: async (entityId: string, reason: "sample" | "conflict") => {
        await db.run(
          "INSERT OR IGNORE INTO golden_entities (entity_id, reason, added_at) VALUES (?, ?, ?)",
          [entityId, reason, nowIso()],
        );
      },
      list: async () =>
        (await db.all<Row>("SELECT * FROM golden_entities ORDER BY added_at, entity_id")).map(
          (r) => ({
            entity_id: r.entity_id as string,
            reason: r.reason as "sample" | "conflict",
            added_at: r.added_at as string,
          }),
        ),
    },

    outcomes: {
      add: async (o: Omit<OutcomeRow, "id">) => {
        await db.run(
          "INSERT INTO outcomes (opportunity_id, entity_id, module, event, value_bool, value_gbp, observed_at, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            o.opportunity_id,
            o.entity_id,
            o.module,
            o.event,
            o.value_bool === null ? null : o.value_bool ? 1 : 0,
            o.value_gbp,
            o.observed_at,
            o.source,
            nowIso(),
          ],
        );
      },
      forEntities: async (event: string, from: string, to: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM outcomes WHERE event = ? AND observed_at > ? AND observed_at <= ? ORDER BY observed_at",
            [event, from, to],
          )
        ).map(toOutcome),
      forOpportunity: async (opportunityId: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM outcomes WHERE opportunity_id = ? ORDER BY observed_at",
            [opportunityId],
          )
        ).map(toOutcome),
      list: async (limit: number) =>
        (
          await db.all<Row>("SELECT * FROM outcomes ORDER BY observed_at DESC LIMIT ?", [limit])
        ).map(toOutcome),
    },

    drift: {
      put: async (rows: DriftRow[]) => {
        for (const r of rows) {
          await db.run(
            "INSERT OR REPLACE INTO drift_metrics (day, source, field, volume, null_rate, mean, top_share, match_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [r.day, r.source, r.field, r.volume, r.null_rate, r.mean, r.top_share, r.match_rate],
          );
        }
      },
      history: async (source: string, field: string, beforeDay: string, days: number) =>
        (
          await db.all<Row>(
            "SELECT * FROM drift_metrics WHERE source = ? AND field = ? AND day < ? ORDER BY day DESC LIMIT ?",
            [source, field, beforeDay, days],
          )
        ).map(
          (r): DriftRow => ({
            day: r.day as string,
            source: r.source as string,
            field: r.field as string,
            volume: Number(r.volume),
            null_rate: Number(r.null_rate),
            mean: r.mean === null ? null : Number(r.mean),
            top_share: r.top_share === null ? null : Number(r.top_share),
            match_rate: Number(r.match_rate),
          }),
        ),
      forDay: async (day: string) =>
        (
          await db.all<Row>("SELECT * FROM drift_metrics WHERE day = ? ORDER BY source, field", [
            day,
          ])
        ).map(
          (r): DriftRow => ({
            day: r.day as string,
            source: r.source as string,
            field: r.field as string,
            volume: Number(r.volume),
            null_rate: Number(r.null_rate),
            mean: r.mean === null ? null : Number(r.mean),
            top_share: r.top_share === null ? null : Number(r.top_share),
            match_rate: Number(r.match_rate),
          }),
        ),
      /** How many complete (succeeded, not partial) runs have fed this source up to the end of `day`. */
      completeRuns: async (source: string, day: string) =>
        Number(
          (
            await db.all<Row>(
              `SELECT COUNT(DISTINCT o.run_id) AS n FROM claim_observations o
               JOIN claims c ON c.claim_id = o.claim_id JOIN runs r ON r.run_id = o.run_id
               WHERE c.source = ? AND o.fetched_at <= ? AND r.status = 'succeeded' AND r.partial = 0`,
              [source, `${day}T23:59:59.999Z`],
            )
          )[0]?.n ?? 0,
        ),
      /** Claims fetched on one day, for computing metrics: (source, field, value, entity_id). */
      claimsOnDay: async (day: string) =>
        (
          await db.all<Row>(
            // Only complete runs count: failed, still-running and partial (resumed/limited) runs are left out.
            `SELECT c.source, c.field, c.value, c.entity_id FROM claim_observations o JOIN claims c ON c.claim_id = o.claim_id
             JOIN runs r ON r.run_id = o.run_id
             WHERE o.fetched_at >= ? AND o.fetched_at <= ? AND r.status = 'succeeded' AND r.partial = 0`,
            [`${day}T00:00:00`, `${day}T23:59:59.999Z`],
          )
        ).map((r) => ({
          source: r.source as string,
          field: r.field as string,
          value: pj(r.value),
          entity_id: (r.entity_id as string | null) ?? null,
        })),
    },

    pauses: {
      pause: async (source: string, field: string, reason: string) => {
        const open = await db.all(
          "SELECT 1 FROM source_pauses WHERE source = ? AND field = ? AND resumed_at IS NULL",
          [source, field],
        );
        if (open.length) return;
        await db.run(
          "INSERT INTO source_pauses (source, field, reason, paused_at) VALUES (?, ?, ?, ?)",
          [source, field, reason, nowIso()],
        );
      },
      resume: async (source: string, field: string) => {
        await db.run(
          "UPDATE source_pauses SET resumed_at = ? WHERE source = ? AND field = ? AND resumed_at IS NULL",
          [nowIso(), source, field],
        );
      },
      active: async () =>
        (
          await db.all<Row>(
            "SELECT source, field, reason, paused_at FROM source_pauses WHERE resumed_at IS NULL ORDER BY paused_at",
          )
        ).map((r) => ({
          source: r.source as string,
          field: r.field as string,
          reason: r.reason as string,
          paused_at: r.paused_at as string,
        })),
    },

    backtests: {
      put: async (b: Omit<BacktestRow, "created_at">) => {
        await db.run(
          `INSERT INTO backtests (id, module, module_version, note_hash, as_of, mode, window_days, candidates, precision_at_20, base_rate, lift, revenue_lift, calibration, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            b.id,
            b.module,
            b.module_version,
            b.note_hash,
            b.as_of,
            b.mode,
            b.window_days,
            b.candidates,
            b.precision_at_20,
            b.base_rate,
            b.lift,
            b.revenue_lift,
            JSON.stringify(b.calibration),
            nowIso(),
          ] as SqlValue[],
        );
      },
      latest: async (module: string): Promise<BacktestRow | null> => {
        const r = (
          await db.all<Row>(
            "SELECT * FROM backtests WHERE module = ? ORDER BY created_at DESC LIMIT 1",
            [module],
          )
        )[0];
        return r
          ? {
              id: r.id as string,
              module: r.module as string,
              module_version: Number(r.module_version),
              note_hash: r.note_hash as string,
              as_of: r.as_of as string,
              mode: r.mode as string,
              window_days: Number(r.window_days),
              candidates: Number(r.candidates),
              precision_at_20: Number(r.precision_at_20),
              base_rate: Number(r.base_rate),
              lift: Number(r.lift),
              revenue_lift: r.revenue_lift === null ? null : Number(r.revenue_lift),
              calibration: pj(r.calibration),
              created_at: r.created_at as string,
            }
          : null;
      },
    },

    suggestions: {
      add: async (s: Omit<SuggestionRow, "status" | "created_at">) => {
        await db.run(
          "INSERT INTO weight_suggestions (id, module, module_version, current_weights, suggested_weights, evidence, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
          [
            s.id,
            s.module,
            s.module_version,
            JSON.stringify(s.current_weights),
            JSON.stringify(s.suggested_weights),
            JSON.stringify(s.evidence),
            nowIso(),
          ],
        );
      },
      get: async (id: string): Promise<SuggestionRow | null> => {
        const r = (await db.all<Row>("SELECT * FROM weight_suggestions WHERE id = ?", [id]))[0];
        return r
          ? {
              id: r.id as string,
              module: r.module as string,
              module_version: Number(r.module_version),
              current_weights: pj(r.current_weights),
              suggested_weights: pj(r.suggested_weights),
              evidence: pj(r.evidence),
              status: r.status as SuggestionRow["status"],
              created_at: r.created_at as string,
            }
          : null;
      },
      decide: async (id: string, status: "accepted" | "rejected") => {
        await db.run(
          "UPDATE weight_suggestions SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
          [status, nowIso(), id],
        );
      },
      pending: async (module: string) =>
        (
          await db.all<Row>(
            "SELECT id FROM weight_suggestions WHERE module = ? AND status = 'pending'",
            [module],
          )
        ).map((r) => r.id as string),
    },

    /** Margin per playbook over a period: cost from the run log, revenue attached to tasks. */
    margins: async (since: string) =>
      (
        await db.all<Row>(
          `SELECT t.playbook, COUNT(*) AS tasks, COALESCE(SUM(t.cost_gbp), 0) AS cost, COALESCE(SUM(t.revenue_gbp), 0) AS revenue,
                  SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
           FROM tasks t WHERE t.created_at >= ? GROUP BY t.playbook ORDER BY t.playbook`,
          [since],
        )
      ).map((r) => ({
        playbook: r.playbook as string,
        tasks: Number(r.tasks),
        done: Number(r.done),
        cost_gbp: Number(r.cost),
        revenue_gbp: Number(r.revenue),
        margin_gbp: Number(r.revenue) - Number(r.cost),
      })),
  };
}

export type Phase3Storage = ReturnType<typeof phase3>;
