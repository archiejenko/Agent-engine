import type { SqlDriver, SqlValue } from "./driver.ts";
import { type LedgerRow, toLedger } from "./v2.ts";

/**
 * v3 Milestone C storage: grouped activity per company for the CRM (a few GROUP BY queries instead of
 * per-company lookups), and ledger rows in a date range for Home.
 */
type Row = Record<string, unknown>;

export interface CompanyActivity {
  entity_id: string;
  name: string | null;
  /** Latest time of each ledger event for this company (sent, reply, paid, churned, …). */
  events: Record<string, string>;
  letters: Record<string, number>;
  claim: { status: string; monthly_gbp: number; updated_at: string } | null;
  opted_out: boolean;
  opportunity: { expected_value_gbp: number; status: string; module: string } | null;
  open_tasks: { task_id: string; playbook: string; status: string; updated_at: string }[];
  synthetic: boolean;
}

export interface DecisionOption {
  key: string;
  label: string;
  /** Plain-English effect, shown under the button. */
  effect: string;
}
export type DecisionStatus = "open" | "decided" | "defaulted" | "superseded";
export interface DecisionRow {
  id: string;
  type: string;
  source_ref: string;
  summary: string;
  money_at_stake_gbp: number;
  money_kind: "real" | "estimated" | "assumed" | "none";
  options: DecisionOption[];
  recommended: string;
  safe_default: string;
  deadline: string;
  context: unknown;
  status: DecisionStatus;
  chosen_option: string | null;
  decided_by: string | null;
  approval_id: string | null;
  error: string | null;
  synthetic: boolean;
  created_at: string;
  decided_at: string | null;
}
const pj = (v: unknown) => (v === null || v === undefined ? null : JSON.parse(v as string));
const toDecision = (r: Row): DecisionRow => ({
  id: r.id as string,
  type: r.type as string,
  source_ref: r.source_ref as string,
  summary: r.summary as string,
  money_at_stake_gbp: Number(r.money_at_stake_gbp),
  money_kind: r.money_kind as DecisionRow["money_kind"],
  options: pj(r.options) as DecisionOption[],
  recommended: r.recommended as string,
  safe_default: r.safe_default as string,
  deadline: r.deadline as string,
  context: pj(r.context),
  status: r.status as DecisionStatus,
  chosen_option: (r.chosen_option as string | null) ?? null,
  decided_by: (r.decided_by as string | null) ?? null,
  approval_id: (r.approval_id as string | null) ?? null,
  error: (r.error as string | null) ?? null,
  synthetic: Number(r.synthetic) === 1,
  created_at: r.created_at as string,
  decided_at: (r.decided_at as string | null) ?? null,
});

export interface MailRow {
  id: string;
  folder: "inbox" | "drafts";
  from: string;
  to: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  entity_id: string | null;
  task_id: string | null;
  untrusted: boolean;
  author: string | null;
  received_at: string;
  synthetic: boolean;
}
const toMail = (r: Row): MailRow => ({
  id: r.id as string,
  folder: r.folder as MailRow["folder"],
  from: r.from_addr as string,
  to: r.to_addr as string,
  subject: r.subject as string,
  body: r.body as string,
  in_reply_to: (r.in_reply_to as string | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  task_id: (r.task_id as string | null) ?? null,
  untrusted: Number(r.untrusted) === 1,
  author: (r.author as string | null) ?? null,
  received_at: r.received_at as string,
  synthetic: Number(r.synthetic) === 1,
});

export interface NoteVersionRow {
  path: string;
  version: number;
  body: string;
  author: string;
  provenance: unknown;
  created_at: string;
}
const toNoteVersion = (r: Row): NoteVersionRow => ({
  path: r.path as string,
  version: Number(r.version),
  body: r.body as string,
  author: r.author as string,
  provenance: pj(r.provenance),
  created_at: r.created_at as string,
});

export function v3Storage(db: SqlDriver) {
  const all = (sql: string, args: SqlValue[] = []) => db.all<Row>(sql, args);
  const nowIso = () => new Date().toISOString();
  return {
    decisions: {
      /** Opens a decision unless one is already open for (type, source_ref). Returns the open one. */
      open: async (
        d: Omit<
          DecisionRow,
          | "id"
          | "status"
          | "chosen_option"
          | "decided_by"
          | "approval_id"
          | "error"
          | "created_at"
          | "decided_at"
        >,
      ): Promise<DecisionRow> => {
        await db.run(
          `INSERT OR IGNORE INTO decisions (id, type, source_ref, summary, money_at_stake_gbp, money_kind, options, recommended, safe_default, deadline, context, status, synthetic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          [
            crypto.randomUUID(),
            d.type,
            d.source_ref,
            d.summary,
            d.money_at_stake_gbp,
            d.money_kind,
            JSON.stringify(d.options),
            d.recommended,
            d.safe_default,
            d.deadline,
            d.context === undefined ? null : JSON.stringify(d.context),
            d.synthetic ? 1 : 0,
            nowIso(),
          ],
        );
        const r = (
          await all(
            "SELECT * FROM decisions WHERE type = ? AND source_ref = ? AND status = 'open'",
            [d.type, d.source_ref],
          )
        )[0];
        return toDecision(r as Row);
      },
      get: async (id: string) => {
        const r = (await all("SELECT * FROM decisions WHERE id = ?", [id]))[0];
        return r ? toDecision(r) : null;
      },
      openFor: async (type: string, sourceRef: string) => {
        const r = (
          await all(
            "SELECT * FROM decisions WHERE type = ? AND source_ref = ? AND status = 'open'",
            [type, sourceRef],
          )
        )[0];
        return r ? toDecision(r) : null;
      },
      /** Open decisions, highest money at stake first, then the nearest deadline. */
      list: async (o: { status?: DecisionStatus; type?: string; limit?: number } = {}) => {
        const where: string[] = [];
        const args: SqlValue[] = [];
        if (o.status) {
          where.push("status = ?");
          args.push(o.status);
        }
        if (o.type) {
          where.push("type = ?");
          args.push(o.type);
        }
        return (
          await all(
            `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, money_at_stake_gbp DESC, deadline ASC, created_at ASC LIMIT ?`,
            [...args, o.limit ?? 200],
          )
        ).map(toDecision);
      },
      /** Closes an open decision exactly once. False if it wasn't open (already decided elsewhere). */
      close: async (
        id: string,
        c: {
          status: Exclude<DecisionStatus, "open">;
          chosen_option: string | null;
          decided_by: string;
          approval_id?: string | null;
        },
      ) =>
        (
          await db.run(
            "UPDATE decisions SET status = ?, chosen_option = ?, decided_by = ?, approval_id = ?, decided_at = ? WHERE id = ? AND status = 'open'",
            [c.status, c.chosen_option, c.decided_by, c.approval_id ?? null, nowIso(), id],
          )
        ).changes === 1,
      setError: async (id: string, error: string) => {
        await db.run("UPDATE decisions SET error = ? WHERE id = ?", [error, id]);
      },
      expired: async (now: string) =>
        (
          await all(
            "SELECT * FROM decisions WHERE status = 'open' AND deadline <= ? ORDER BY deadline",
            [now],
          )
        ).map(toDecision),
      openCount: async () =>
        Number((await all("SELECT COUNT(*) AS n FROM decisions WHERE status = 'open'"))[0]?.n ?? 0),
      since: async (sinceIso: string) =>
        (
          await all("SELECT * FROM decisions WHERE decided_at >= ? ORDER BY decided_at", [sinceIso])
        ).map(toDecision),
    },

    mail: {
      add: async (m: {
        id: string;
        folder: "inbox" | "drafts";
        from: string;
        to: string;
        subject: string;
        body: string;
        in_reply_to?: string | null;
        entity_id?: string | null;
        task_id?: string | null;
        untrusted: boolean;
        author?: string | null;
        received_at: string;
        synthetic?: boolean;
      }) => {
        await db.run(
          `INSERT OR IGNORE INTO mail_messages (id, folder, from_addr, to_addr, subject, body, in_reply_to, entity_id, task_id, untrusted, author, received_at, synthetic)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            m.folder,
            m.from,
            m.to,
            m.subject,
            m.body,
            m.in_reply_to ?? null,
            m.entity_id ?? null,
            m.task_id ?? null,
            m.untrusted ? 1 : 0,
            m.author ?? null,
            m.received_at,
            m.synthetic ? 1 : 0,
          ],
        );
      },
      list: async (o: {
        folder: "inbox" | "drafts";
        limit: number;
        since?: string;
        includeSynthetic?: boolean;
      }) =>
        (
          await all(
            `SELECT * FROM mail_messages WHERE folder = ? AND received_at >= ?${o.includeSynthetic === false ? " AND synthetic = 0" : ""} ORDER BY received_at DESC LIMIT ?`,
            [o.folder, o.since ?? "", o.limit],
          )
        ).map(toMail),
      get: async (id: string) => {
        const r = (await all("SELECT * FROM mail_messages WHERE id = ?", [id]))[0];
        return r ? toMail(r) : null;
      },
    },

    noteVersions: {
      /** Appends a version (never updates one). Returns its number. */
      add: async (v: { path: string; body: string; author: string; provenance: unknown }) => {
        const last = Number(
          (await all("SELECT MAX(version) AS v FROM note_versions WHERE path = ?", [v.path]))[0]
            ?.v ?? 0,
        );
        await db.run(
          "INSERT INTO note_versions (id, path, version, body, author, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID(),
            v.path,
            last + 1,
            v.body,
            v.author,
            v.provenance === undefined ? null : JSON.stringify(v.provenance),
            nowIso(),
          ],
        );
        return last + 1;
      },
      history: async (path: string) =>
        (await all("SELECT * FROM note_versions WHERE path = ? ORDER BY version", [path])).map(
          toNoteVersion,
        ),
      latestAll: async () =>
        (
          await all(
            `SELECT n.* FROM note_versions n JOIN (SELECT path, MAX(version) AS v FROM note_versions GROUP BY path) m
             ON m.path = n.path AND m.v = n.version`,
          )
        ).map(toNoteVersion),
    },

    digests: {
      put: async (day: string, body: unknown) => {
        await db.run(
          "INSERT INTO digests (day, body, created_at) VALUES (?, ?, ?) ON CONFLICT (day) DO UPDATE SET body = excluded.body, created_at = excluded.created_at",
          [day, JSON.stringify(body), nowIso()],
        );
      },
      get: async (day: string) => {
        const r = (await all("SELECT * FROM digests WHERE day = ?", [day]))[0];
        return r
          ? { day: r.day as string, body: pj(r.body), created_at: r.created_at as string }
          : null;
      },
      latest: async () => {
        const r = (await all("SELECT * FROM digests ORDER BY day DESC LIMIT 1"))[0];
        return r
          ? { day: r.day as string, body: pj(r.body), created_at: r.created_at as string }
          : null;
      },
    },

    crm: {
      /**
       * Every company with any outreach activity (or a live opportunity), with what the CRM needs to
       * derive its stage. `includeSynthetic` adds simulator rows (labelled by the caller).
       */
      activity: async (o: { includeSynthetic: boolean }): Promise<CompanyActivity[]> => {
        const syn = o.includeSynthetic ? "" : " AND synthetic = 0";
        const map = new Map<string, CompanyActivity>();
        const get = (id: string) => {
          let a = map.get(id);
          if (!a) {
            a = {
              entity_id: id,
              name: null,
              events: {},
              letters: {},
              claim: null,
              opted_out: false,
              opportunity: null,
              open_tasks: [],
              synthetic: false,
            };
            map.set(id, a);
          }
          return a;
        };
        for (const r of await all(
          `SELECT entity_id, event, MAX(observed_at) AS at, MAX(synthetic) AS syn FROM outcomes
           WHERE dedupe_key IS NOT NULL${syn} GROUP BY entity_id, event`,
        )) {
          const a = get(r.entity_id as string);
          a.events[r.event as string] = r.at as string;
          if (Number(r.syn) === 1) a.synthetic = true;
        }
        for (const r of await all(
          `SELECT entity_id, status, COUNT(*) AS n FROM letters WHERE 1 = 1${syn} GROUP BY entity_id, status`,
        ))
          get(r.entity_id as string).letters[r.status as string] = Number(r.n);
        for (const r of await all(
          `SELECT entity_id, status, monthly_gbp, updated_at, synthetic FROM site_claims WHERE 1 = 1${syn} ORDER BY updated_at`,
        )) {
          const a = get(r.entity_id as string);
          a.claim = {
            status: r.status as string,
            monthly_gbp: Number(r.monthly_gbp),
            updated_at: r.updated_at as string,
          };
          if (Number(r.synthetic) === 1) a.synthetic = true;
        }
        for (const r of await all(
          `SELECT entity_id, expected_value_gbp, status, module FROM opportunities
           WHERE status IN ('proposed', 'approved', 'actioned') ORDER BY created_at`,
        ))
          get(r.entity_id as string).opportunity = {
            expected_value_gbp: Number(r.expected_value_gbp),
            status: r.status as string,
            module: r.module as string,
          };
        for (const r of await all(
          `SELECT task_id, playbook, status, updated_at, source_ref FROM tasks
           WHERE status IN ('queued', 'running', 'awaiting_approval')${syn} ORDER BY updated_at DESC`,
        )) {
          const id = (r.source_ref as string).match(/:entity:([A-Z0-9]{8})$/)?.[1];
          if (id)
            get(id).open_tasks.push({
              task_id: r.task_id as string,
              playbook: r.playbook as string,
              status: r.status as string,
              updated_at: r.updated_at as string,
            });
        }
        // Opted out: the company itself ("entity:<number>") or an address we wrote to.
        for (const r of await all(
          "SELECT substr(address, 8) AS id FROM suppressions WHERE address LIKE 'entity:%'",
        ))
          if (map.has((r.id as string).toUpperCase()))
            get((r.id as string).toUpperCase()).opted_out = true;
        for (const r of await all(
          `SELECT DISTINCT o.entity_id AS id FROM outbox o JOIN suppressions s ON s.address = lower(o.recipient)
           WHERE o.entity_id IS NOT NULL`,
        ))
          if (map.has(r.id as string)) get(r.id as string).opted_out = true;
        const ids = [...map.keys()];
        for (let i = 0; i < ids.length; i += 200) {
          const chunk = ids.slice(i, i + 200);
          for (const r of await all(
            `SELECT entity_id, name FROM entities WHERE entity_id IN (${chunk.map(() => "?").join(",")})`,
            chunk,
          ))
            get(r.entity_id as string).name = r.name as string;
        }
        return [...map.values()];
      },
    },

    ledgerRange: async (o: {
      from: string;
      to: string;
      includeSynthetic: boolean;
      playbook?: string;
    }): Promise<LedgerRow[]> => {
      const where = ["dedupe_key IS NOT NULL", "observed_at >= ?", "observed_at < ?"];
      const args: SqlValue[] = [o.from, o.to];
      if (!o.includeSynthetic) where.push("synthetic = 0");
      if (o.playbook) {
        where.push("playbook = ?");
        args.push(o.playbook);
      }
      const rows = await all(
        `SELECT * FROM outcomes WHERE ${where.join(" AND ")} ORDER BY observed_at`,
        args,
      );
      return rows.map(toLedger);
    },

    ledgerForEntity: async (entityId: string): Promise<LedgerRow[]> => {
      const rows = await all(
        "SELECT * FROM outcomes WHERE dedupe_key IS NOT NULL AND entity_id = ? ORDER BY observed_at DESC LIMIT 500",
        [entityId],
      );
      return rows.map(toLedger);
    },
  };
}

export type V3Storage = ReturnType<typeof v3Storage>;
