import type { SqlDriver, SqlValue } from "./driver.ts";

/** v2 Phase 4 storage: site claims and workflow events. */
type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const j = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));

export type ClaimStatus =
  | "checkout_started"
  | "paid"
  | "details_received"
  | "awaiting_publish"
  | "published"
  | "cancelled"
  | "refunded";

export interface ClaimRow {
  id: string;
  slug: string;
  entity_id: string;
  source_task_id: string | null;
  task_id: string | null;
  email: string;
  name: string | null;
  status: ClaimStatus;
  session_id: string | null;
  subscription_id: string | null;
  workflow_id: string | null;
  details: unknown;
  details_token: string;
  terms_version: string;
  setup_fee_gbp: number;
  monthly_gbp: number;
  synthetic: boolean;
  created_at: string;
  updated_at: string;
}

const toClaim = (r: Row): ClaimRow => ({
  id: r.id as string,
  slug: r.slug as string,
  entity_id: r.entity_id as string,
  source_task_id: (r.source_task_id as string | null) ?? null,
  task_id: (r.task_id as string | null) ?? null,
  email: r.email as string,
  name: (r.name as string | null) ?? null,
  status: r.status as ClaimStatus,
  session_id: (r.session_id as string | null) ?? null,
  subscription_id: (r.subscription_id as string | null) ?? null,
  workflow_id: (r.workflow_id as string | null) ?? null,
  details: pj(r.details),
  details_token: r.details_token as string,
  terms_version: r.terms_version as string,
  setup_fee_gbp: Number(r.setup_fee_gbp),
  monthly_gbp: Number(r.monthly_gbp),
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  updated_at: r.updated_at as string,
});

export function claimsStorage(db: SqlDriver) {
  const one = async (sql: string, args: SqlValue[]) => {
    const r = (await db.all<Row>(sql, args))[0];
    return r ? toClaim(r) : null;
  };
  return {
    siteClaims: {
      create: async (
        c: Omit<
          ClaimRow,
          "created_at" | "updated_at" | "task_id" | "workflow_id" | "details" | "subscription_id"
        >,
      ) => {
        const at = nowIso();
        await db.run(
          `INSERT INTO site_claims (id, slug, entity_id, source_task_id, email, name, status, session_id, details_token, terms_version, setup_fee_gbp, monthly_gbp, synthetic, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            c.id,
            c.slug,
            c.entity_id,
            c.source_task_id,
            c.email,
            c.name,
            c.status,
            c.session_id,
            c.details_token,
            c.terms_version,
            c.setup_fee_gbp,
            c.monthly_gbp,
            c.synthetic ? 1 : 0,
            at,
            at,
          ],
        );
      },
      get: (id: string) => one("SELECT * FROM site_claims WHERE id = ?", [id]),
      bySession: (sessionId: string) =>
        one("SELECT * FROM site_claims WHERE session_id = ?", [sessionId]),
      bySubscription: (sub: string) =>
        one("SELECT * FROM site_claims WHERE subscription_id = ?", [sub]),
      byToken: (token: string) => one("SELECT * FROM site_claims WHERE details_token = ?", [token]),
      update: async (
        id: string,
        p: Partial<
          Pick<
            ClaimRow,
            "status" | "session_id" | "subscription_id" | "task_id" | "workflow_id" | "details"
          >
        >,
      ) => {
        const sets: string[] = ["updated_at = ?"];
        const args: SqlValue[] = [nowIso()];
        for (const [k, v] of Object.entries(p)) {
          sets.push(`${k} = ?`);
          args.push(k === "details" ? j(v) : ((v ?? null) as SqlValue));
        }
        await db.run(`UPDATE site_claims SET ${sets.join(", ")} WHERE id = ?`, [...args, id]);
      },
      list: async (o: { includeSynthetic?: boolean; limit?: number } = {}) =>
        (
          await db.all<Row>(
            `SELECT * FROM site_claims ${o.includeSynthetic ? "" : "WHERE synthetic = 0"} ORDER BY updated_at DESC LIMIT ?`,
            [o.limit ?? 100],
          )
        ).map(toClaim),
    },

    workflowEvents: {
      add: async (instanceId: string, type: string, payload: unknown) => {
        await db.run(
          "INSERT INTO workflow_events (id, instance_id, type, payload, received_at) VALUES (?, ?, ?, ?, ?)",
          [crypto.randomUUID(), instanceId, type, j(payload), nowIso()],
        );
      },
      /** The oldest unconsumed event of this type, marked consumed. */
      take: async (instanceId: string, type: string) => {
        const r = (
          await db.all<Row>(
            "SELECT id, payload FROM workflow_events WHERE instance_id = ? AND type = ? AND consumed_at IS NULL ORDER BY received_at LIMIT 1",
            [instanceId, type],
          )
        )[0];
        if (!r) return null;
        await db.run("UPDATE workflow_events SET consumed_at = ? WHERE id = ?", [
          nowIso(),
          r.id as string,
        ]);
        return { payload: pj(r.payload) };
      },
    },
  };
}

export type ClaimsStorage = ReturnType<typeof claimsStorage>;
