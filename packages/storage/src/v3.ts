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

export function v3Storage(db: SqlDriver) {
  const all = (sql: string, args: SqlValue[] = []) => db.all<Row>(sql, args);
  return {
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
