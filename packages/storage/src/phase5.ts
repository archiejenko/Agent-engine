import type { SqlDriver } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  plan: "per_alert" | "monthly";
  payment_ref: string | null;
  active: boolean;
}
export interface WatchRow {
  id: string;
  customer_id: string;
  entity_id: string;
  fields: string[];
  channel: "webhook" | "email";
  target: string;
  active: boolean;
}
export interface OutboxRow {
  id: string;
  task_id: string | null;
  thread_id: string;
  attempt: number;
  entity_id: string | null;
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  status: "sent" | "dry_run" | "blocked";
  reason: string | null;
  created_at: string;
}

const toOutbox = (r: Row): OutboxRow => ({
  id: r.id as string,
  task_id: (r.task_id as string | null) ?? null,
  thread_id: r.thread_id as string,
  attempt: Number(r.attempt),
  entity_id: (r.entity_id as string | null) ?? null,
  recipient: r.recipient as string,
  sender: r.sender as string,
  subject: r.subject as string,
  body: r.body as string,
  status: r.status as OutboxRow["status"],
  reason: (r.reason as string | null) ?? null,
  created_at: r.created_at as string,
});

/** Phase 5 storage namespaces. */
export function phase5(db: SqlDriver) {
  return {
    customers: {
      add: async (c: Omit<CustomerRow, "id" | "active"> & { id?: string }) => {
        const id = c.id ?? crypto.randomUUID();
        await db.run(
          "INSERT INTO customers (id, name, email, plan, payment_ref, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
          [id, c.name, c.email, c.plan, c.payment_ref, nowIso()],
        );
        return id;
      },
      get: async (id: string): Promise<CustomerRow | null> => {
        const r = (await db.all<Row>("SELECT * FROM customers WHERE id = ?", [id]))[0];
        return r
          ? {
              id: r.id as string,
              name: r.name as string,
              email: r.email as string,
              plan: r.plan as CustomerRow["plan"],
              payment_ref: (r.payment_ref as string | null) ?? null,
              active: Number(r.active) === 1,
            }
          : null;
      },
      count: async () =>
        Number(
          (await db.all<{ n: number }>("SELECT COUNT(*) AS n FROM customers WHERE active = 1"))[0]
            ?.n ?? 0,
        ),
    },

    watches: {
      add: async (w: Omit<WatchRow, "id" | "active">) => {
        const id = crypto.randomUUID();
        await db.run(
          "INSERT INTO watches (id, customer_id, entity_id, fields, channel, target, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)",
          [id, w.customer_id, w.entity_id, JSON.stringify(w.fields), w.channel, w.target, nowIso()],
        );
        return id;
      },
      active: async (): Promise<WatchRow[]> =>
        (await db.all<Row>("SELECT * FROM watches WHERE active = 1 ORDER BY created_at")).map(
          (r) => ({
            id: r.id as string,
            customer_id: r.customer_id as string,
            entity_id: r.entity_id as string,
            fields: pj(r.fields) as string[],
            channel: r.channel as WatchRow["channel"],
            target: r.target as string,
            active: true,
          }),
        ),
      /** Record an alert once per watch + fact version (idempotent). Returns false if already sent. */
      recordAlert: async (a: {
        watch_id: string;
        entity_id: string;
        field: string;
        old_value: unknown;
        new_value: unknown;
        fact_version: number;
        task_id: string | null;
        charged_gbp: number;
      }) => {
        const r = await db.run(
          "INSERT OR IGNORE INTO watch_alerts (id, watch_id, entity_id, field, old_value, new_value, fact_version, task_id, charged_gbp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID(),
            a.watch_id,
            a.entity_id,
            a.field,
            a.old_value === undefined ? null : JSON.stringify(a.old_value),
            JSON.stringify(a.new_value),
            a.fact_version,
            a.task_id,
            a.charged_gbp,
            nowIso(),
          ],
        );
        return r.changes === 1;
      },
      alerts: async (watchId: string) =>
        (
          await db.all<Row>("SELECT * FROM watch_alerts WHERE watch_id = ? ORDER BY created_at", [
            watchId,
          ])
        ).map((r) => ({
          field: r.field as string,
          old_value: pj(r.old_value),
          new_value: pj(r.new_value),
          fact_version: Number(r.fact_version),
          charged_gbp: Number(r.charged_gbp),
          task_id: (r.task_id as string | null) ?? null,
        })),
    },

    suppressions: {
      add: async (address: string, reason: string) => {
        await db.run(
          "INSERT OR IGNORE INTO suppressions (address, reason, added_at) VALUES (?, ?, ?)",
          [address.toLowerCase(), reason, nowIso()],
        );
      },
      /** Suppressed if the exact address or its whole domain is on the list. */
      isSuppressed: async (email: string) => {
        const e = email.toLowerCase();
        const domain = e.split("@")[1] ?? "";
        return (
          (await db.all("SELECT 1 FROM suppressions WHERE address = ? OR address = ?", [e, domain]))
            .length > 0
        );
      },
    },

    outbox: {
      add: async (m: Omit<OutboxRow, "id" | "created_at">) => {
        const id = crypto.randomUUID();
        await db.run(
          "INSERT INTO outbox (id, task_id, thread_id, attempt, entity_id, recipient, sender, subject, body, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            m.task_id,
            m.thread_id,
            m.attempt,
            m.entity_id,
            m.recipient.toLowerCase(),
            m.sender,
            m.subject,
            m.body,
            m.status,
            m.reason,
            nowIso(),
          ],
        );
        return id;
      },
      get: async (id: string) => {
        const r = (await db.all<Row>("SELECT * FROM outbox WHERE id = ?", [id]))[0];
        return r ? toOutbox(r) : null;
      },
      forRecipient: async (recipient: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM outbox WHERE recipient = ? AND status != 'blocked' ORDER BY created_at",
            [recipient.toLowerCase()],
          )
        ).map(toOutbox),
      list: async (limit: number) =>
        (await db.all<Row>("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?", [limit])).map(
          toOutbox,
        ),
      /** Emails to one company that weren't blocked (sent or dry run), newest first. */
      forEntity: async (entityId: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM outbox WHERE entity_id = ? AND status != 'blocked' ORDER BY created_at DESC",
            [entityId],
          )
        ).map(toOutbox),
    },

    followups: {
      schedule: async (f: {
        thread_id: string;
        attempt: number;
        entity_id: string;
        opportunity_id: string | null;
        due_at: string;
      }) => {
        await db.run(
          "INSERT OR IGNORE INTO followups (thread_id, attempt, entity_id, opportunity_id, due_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
          [f.thread_id, f.attempt, f.entity_id, f.opportunity_id, f.due_at],
        );
      },
      due: async (now: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM followups WHERE status = 'pending' AND due_at <= ? ORDER BY due_at",
            [now],
          )
        ).map((r) => ({
          thread_id: r.thread_id as string,
          attempt: Number(r.attempt),
          entity_id: r.entity_id as string,
          opportunity_id: (r.opportunity_id as string | null) ?? null,
        })),
      mark: async (
        threadId: string,
        attempt: number,
        status: "created" | "cancelled",
        reason?: string,
      ) => {
        await db.run(
          "UPDATE followups SET status = ?, reason = ? WHERE thread_id = ? AND attempt = ?",
          [status, reason ?? null, threadId, attempt],
        );
      },
      cancelThread: async (threadId: string, reason: string) => {
        await db.run(
          "UPDATE followups SET status = 'cancelled', reason = ? WHERE thread_id = ? AND status = 'pending'",
          [reason, threadId],
        );
      },
    },
  };
}

export type Phase5Storage = ReturnType<typeof phase5>;
