import type { Arm, LedgerEventParsed } from "@ae/contracts";
import type { SqlDriver, SqlValue } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const first = async (db: SqlDriver, sql: string, params: SqlValue[] = []) =>
  (await db.all<Row>(sql, params))[0] ?? null;

export interface LedgerRow {
  id: number;
  event: string;
  entity_id: string;
  task_id: string | null;
  playbook: string | null;
  playbook_version: number | null;
  opportunity_id: string | null;
  experiment_id: string | null;
  hypothesis_id: string | null;
  cohort_id: string | null;
  arm: Arm | null;
  value_gbp: number | null;
  value_kind: "actual" | "estimate";
  assumption: string | null;
  ms_on_page: number | null;
  observed_at: string;
  recorded_at: string;
  source: string;
  synthetic: boolean;
  dry_run: boolean;
}

const toLedger = (r: Row): LedgerRow => ({
  id: Number(r.id),
  event: r.event as string,
  entity_id: r.entity_id as string,
  task_id: (r.task_id as string | null) ?? null,
  playbook: (r.playbook as string | null) ?? null,
  playbook_version: r.playbook_version === null ? null : Number(r.playbook_version),
  opportunity_id: (r.opportunity_id as string | null) ?? null,
  experiment_id: (r.experiment_id as string | null) ?? null,
  hypothesis_id: (r.hypothesis_id as string | null) ?? null,
  cohort_id: (r.cohort_id as string | null) ?? null,
  arm: (r.arm as Arm | null) ?? null,
  value_gbp: r.value_gbp === null ? null : Number(r.value_gbp),
  value_kind: (r.value_kind as "actual" | "estimate") ?? "actual",
  assumption: (r.assumption as string | null) ?? null,
  ms_on_page: r.ms_on_page === null || r.ms_on_page === undefined ? null : Number(r.ms_on_page),
  observed_at: r.observed_at as string,
  recorded_at: r.created_at as string,
  source: r.source as string,
  synthetic: Number(r.synthetic) === 1,
  dry_run: Number(r.dry_run) === 1,
});

/**
 * Rows learning may read: real (not synthetic), really sent (not dry-run), and known by `asOf`
 * (both when it happened and when we recorded it). Every learning query uses this.
 */
const LEARNING = "synthetic = 0 AND dry_run = 0 AND created_at <= ? AND observed_at <= ?";

export interface CohortRow {
  id: string;
  created_at: string;
  seed: string;
  holdout_share: number;
  ranked: number;
  holdout: number;
  synthetic: boolean;
}
export interface CohortMemberRow {
  cohort_id: string;
  entity_id: string;
  arm: Arm;
  channel: "email" | "letter" | null;
  p_paid: number | null;
  ev_gbp: number | null;
  task_id: string | null;
  status: "assigned" | "skipped";
  reason: string | null;
}
export interface ReviewSessionRow {
  id: string;
  item_type: string;
  item_id: string;
  task_ids: string[];
  started_at: string;
  decided_at: string;
  active_ms: number;
  synthetic: boolean;
}

export function v2Storage(db: SqlDriver) {
  return {
    outcomeLedger: {
      /** Idempotent on dedupe_key: recording the same event twice stores it once. */
      record: async (e: LedgerEventParsed): Promise<boolean> => {
        const r = await db.run(
          `INSERT OR IGNORE INTO outcomes (opportunity_id, entity_id, module, event, value_bool, value_gbp, observed_at, source, created_at,
             task_id, playbook, playbook_version, experiment_id, hypothesis_id, cohort_id, arm, value_kind, assumption, ms_on_page, synthetic, dry_run, dedupe_key)
           VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            e.opportunity_id,
            e.entity_id,
            e.event,
            e.value_gbp,
            e.observed_at,
            e.source,
            nowIso(),
            e.task_id,
            e.playbook,
            e.playbook_version,
            e.experiment_id,
            e.hypothesis_id,
            e.cohort_id,
            e.arm,
            e.value_kind,
            e.assumption,
            e.ms_on_page,
            e.synthetic ? 1 : 0,
            e.dry_run ? 1 : 0,
            e.dedupe_key,
          ],
        );
        return r.changes === 1;
      },
      setMsOnPage: async (dedupeKey: string, ms: number) => {
        await db.run("UPDATE outcomes SET ms_on_page = ? WHERE dedupe_key = ?", [ms, dedupeKey]);
      },
      list: async (o: { limit: number; taskId?: string; event?: string }) => {
        const where: string[] = ["dedupe_key IS NOT NULL"];
        const args: SqlValue[] = [];
        if (o.taskId) {
          where.push("task_id = ?");
          args.push(o.taskId);
        }
        if (o.event) {
          where.push("event = ?");
          args.push(o.event);
        }
        return (
          await db.all<Row>(
            `SELECT * FROM outcomes WHERE ${where.join(" AND ")} ORDER BY observed_at DESC, id DESC LIMIT ?`,
            [...args, o.limit],
          )
        ).map(toLedger);
      },
      /**
       * LEARNING: distinct tasks per event for one playbook, real and known by asOf only (v2 rules 10–11).
       * Counts tasks, not rows, so a reply recorded twice can't double-count.
       */
      learningCounts: async (
        playbook: string,
        asOf: string,
      ): Promise<{ sent: number; reply: number; paid: number }> => {
        const rows = await db.all<Row>(
          `SELECT event, COUNT(DISTINCT COALESCE(task_id, entity_id)) AS n FROM outcomes
           WHERE playbook = ? AND event IN ('sent', 'reply', 'paid') AND ${LEARNING} GROUP BY event`,
          [playbook, asOf, asOf],
        );
        const get = (ev: string) => Number(rows.find((r) => r.event === ev)?.n ?? 0);
        return { sent: get("sent"), reply: get("reply"), paid: get("paid") };
      },
      /**
       * REPORT (not learning): companies reaching each event, per cohort arm. `includeSynthetic` is for
       * simulator readouts, which are labelled as such; learning never calls this.
       */
      cohortFunnel: async (o: {
        includeSynthetic: boolean;
        cohortIds?: string[];
      }): Promise<{ arm: Arm; event: string; companies: number }[]> => {
        const where = ["cohort_id IS NOT NULL", "arm IS NOT NULL"];
        const args: SqlValue[] = [];
        if (!o.includeSynthetic) where.push("synthetic = 0");
        if (o.cohortIds?.length) {
          where.push(`cohort_id IN (${o.cohortIds.map(() => "?").join(", ")})`);
          args.push(...o.cohortIds);
        }
        return (
          await db.all<Row>(
            `SELECT arm, event, COUNT(DISTINCT entity_id) AS n FROM outcomes WHERE ${where.join(" AND ")} GROUP BY arm, event`,
            args,
          )
        ).map((r) => ({ arm: r.arm as Arm, event: r.event as string, companies: Number(r.n) }));
      },
      /** £ moved (actual) per task, for unit economics. */
      revenueByTask: async (taskIds: string[]): Promise<Map<string, number>> => {
        const out = new Map<string, number>();
        for (let i = 0; i < taskIds.length; i += 200) {
          const chunk = taskIds.slice(i, i + 200);
          const rows = await db.all<Row>(
            `SELECT task_id, SUM(CASE WHEN event = 'paid' THEN value_gbp WHEN event = 'refunded' THEN -value_gbp ELSE 0 END) AS gbp
             FROM outcomes WHERE value_kind = 'actual' AND task_id IN (${chunk.map(() => "?").join(", ")}) GROUP BY task_id`,
            chunk,
          );
          for (const r of rows) out.set(r.task_id as string, Number(r.gbp ?? 0));
        }
        return out;
      },
    },

    cohorts: {
      create: async (c: Omit<CohortRow, "created_at">) => {
        await db.run(
          "INSERT INTO outreach_cohorts (id, created_at, seed, holdout_share, ranked, holdout, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [c.id, nowIso(), c.seed, c.holdout_share, c.ranked, c.holdout, c.synthetic ? 1 : 0],
        );
      },
      setCounts: async (id: string, ranked: number, holdout: number) => {
        await db.run("UPDATE outreach_cohorts SET ranked = ?, holdout = ? WHERE id = ?", [
          ranked,
          holdout,
          id,
        ]);
      },
      get: async (id: string): Promise<CohortRow | null> => {
        const r = await first(db, "SELECT * FROM outreach_cohorts WHERE id = ?", [id]);
        return r
          ? {
              id: r.id as string,
              created_at: r.created_at as string,
              seed: r.seed as string,
              holdout_share: Number(r.holdout_share),
              ranked: Number(r.ranked),
              holdout: Number(r.holdout),
              synthetic: Number(r.synthetic) === 1,
            }
          : null;
      },
      list: async (o: { includeSynthetic: boolean; limit: number }): Promise<CohortRow[]> =>
        (
          await db.all<Row>(
            `SELECT * FROM outreach_cohorts ${o.includeSynthetic ? "" : "WHERE synthetic = 0"} ORDER BY created_at DESC LIMIT ?`,
            [o.limit],
          )
        ).map((r) => ({
          id: r.id as string,
          created_at: r.created_at as string,
          seed: r.seed as string,
          holdout_share: Number(r.holdout_share),
          ranked: Number(r.ranked),
          holdout: Number(r.holdout),
          synthetic: Number(r.synthetic) === 1,
        })),
      addMember: async (m: CohortMemberRow) => {
        await db.run(
          "INSERT OR REPLACE INTO cohort_members (cohort_id, entity_id, arm, channel, p_paid, ev_gbp, task_id, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            m.cohort_id,
            m.entity_id,
            m.arm,
            m.channel,
            m.p_paid,
            m.ev_gbp,
            m.task_id,
            m.status,
            m.reason,
          ],
        );
      },
      members: async (cohortId: string): Promise<CohortMemberRow[]> =>
        (
          await db.all<Row>(
            "SELECT * FROM cohort_members WHERE cohort_id = ? ORDER BY arm, entity_id",
            [cohortId],
          )
        ).map((r) => ({
          cohort_id: r.cohort_id as string,
          entity_id: r.entity_id as string,
          arm: r.arm as Arm,
          channel: (r.channel as "email" | "letter" | null) ?? null,
          p_paid: r.p_paid === null ? null : Number(r.p_paid),
          ev_gbp: r.ev_gbp === null ? null : Number(r.ev_gbp),
          task_id: (r.task_id as string | null) ?? null,
          status: r.status as "assigned" | "skipped",
          reason: (r.reason as string | null) ?? null,
        })),
      /** Every entity ever drawn into any cohort (so the holdout never re-picks a company). */
      memberEntities: async (): Promise<Set<string>> =>
        new Set(
          (await db.all<Row>("SELECT DISTINCT entity_id FROM cohort_members")).map(
            (r) => r.entity_id as string,
          ),
        ),
    },

    demoVisits: {
      add: async (v: {
        id: string;
        slug: string;
        entity_id: string;
        task_id: string | null;
        source: "qr" | "link";
        visited_at: string;
        synthetic: boolean;
      }) => {
        await db.run(
          "INSERT INTO demo_visits (id, slug, entity_id, task_id, source, visited_at, ms_on_page, synthetic) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
          [v.id, v.slug, v.entity_id, v.task_id, v.source, v.visited_at, v.synthetic ? 1 : 0],
        );
      },
      /** The latest visit to a page that has no time-on-page yet (the beacon fills it in). */
      latestOpen: async (slug: string, sinceIso: string) => {
        const r = await first(
          db,
          "SELECT id FROM demo_visits WHERE slug = ? AND ms_on_page IS NULL AND visited_at >= ? ORDER BY visited_at DESC LIMIT 1",
          [slug, sinceIso],
        );
        return r ? (r.id as string) : null;
      },
      setMs: async (id: string, ms: number) => {
        await db.run("UPDATE demo_visits SET ms_on_page = ? WHERE id = ?", [ms, id]);
      },
      forSlug: async (slug: string) =>
        db.all<Row>("SELECT * FROM demo_visits WHERE slug = ? ORDER BY visited_at", [slug]),
    },

    reviewSessions: {
      add: async (s: ReviewSessionRow) => {
        await db.run(
          "INSERT OR IGNORE INTO review_sessions (id, item_type, item_id, task_ids, started_at, decided_at, active_ms, synthetic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            s.id,
            s.item_type,
            s.item_id,
            JSON.stringify(s.task_ids),
            s.started_at,
            s.decided_at,
            s.active_ms,
            s.synthetic ? 1 : 0,
          ],
        );
      },
      since: async (o: { since: string; includeSynthetic: boolean }): Promise<ReviewSessionRow[]> =>
        (
          await db.all<Row>(
            `SELECT * FROM review_sessions WHERE decided_at >= ? ${o.includeSynthetic ? "" : "AND synthetic = 0"} ORDER BY decided_at`,
            [o.since],
          )
        ).map((r) => ({
          id: r.id as string,
          item_type: r.item_type as string,
          item_id: r.item_id as string,
          task_ids: JSON.parse(r.task_ids as string) as string[],
          started_at: r.started_at as string,
          decided_at: r.decided_at as string,
          active_ms: Number(r.active_ms),
          synthetic: Number(r.synthetic) === 1,
        })),
    },
  };
}

export type V2Storage = ReturnType<typeof v2Storage>;
