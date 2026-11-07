import type { SqlDriver } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();

export interface X402RequestRow {
  id: string;
  company_number: string;
  tier: "cached" | "premium";
  status: "challenge" | "invalid_payment" | "served" | "not_found" | "failed" | "settle_failed";
  price_usd: number;
  price_gbp: number;
  cost_gbp: number;
  payer: string | null;
  transaction_ref: string | null;
  network: string;
  latency_ms: number;
  dry_run: boolean;
  task_id: string | null;
  created_at?: string;
}

/** Phase 4 storage namespaces (x402, payments ledger, blind verifier). */
export function phase4(db: SqlDriver) {
  return {
    x402: {
      log: async (r: X402RequestRow) => {
        await db.run(
          `INSERT INTO x402_requests (id, company_number, tier, status, price_usd, price_gbp, cost_gbp, payer, transaction_ref, network, latency_ms, dry_run, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.id,
            r.company_number,
            r.tier,
            r.status,
            r.price_usd,
            r.price_gbp,
            r.cost_gbp,
            r.payer,
            r.transaction_ref,
            r.network,
            r.latency_ms,
            r.dry_run ? 1 : 0,
            r.task_id,
            r.created_at ?? nowIso(),
          ],
        );
      },
      since: async (since: string) =>
        (
          await db.all<Row>(
            "SELECT * FROM x402_requests WHERE created_at >= ? ORDER BY created_at",
            [since],
          )
        ).map(
          (r): X402RequestRow => ({
            id: r.id as string,
            company_number: r.company_number as string,
            tier: r.tier as X402RequestRow["tier"],
            status: r.status as X402RequestRow["status"],
            price_usd: Number(r.price_usd),
            price_gbp: Number(r.price_gbp),
            cost_gbp: Number(r.cost_gbp),
            payer: (r.payer as string | null) ?? null,
            transaction_ref: (r.transaction_ref as string | null) ?? null,
            network: r.network as string,
            latency_ms: Number(r.latency_ms),
            dry_run: Number(r.dry_run) === 1,
            task_id: (r.task_id as string | null) ?? null,
            created_at: r.created_at as string,
          }),
        ),
      /** Distinct paying agents per company over a window (feeds the x402_discovery module). */
      interest: async (since: string) =>
        (
          await db.all<Row>(
            "SELECT company_number, COUNT(DISTINCT payer) AS payers FROM x402_requests WHERE status = 'served' AND created_at >= ? GROUP BY company_number",
            [since],
          )
        ).map((r) => ({ company_number: r.company_number as string, payers: Number(r.payers) })),
    },

    ledger: {
      record: async (e: {
        rail: "x402" | "stripe";
        reference: string;
        payer: string | null;
        amount_gbp: number;
        currency_amount: string;
        dry_run: boolean;
        task_id: string | null;
      }) => {
        const r = await db.run(
          "INSERT OR IGNORE INTO payments_ledger (id, rail, reference, payer, amount_gbp, currency_amount, dry_run, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            crypto.randomUUID(),
            e.rail,
            e.reference,
            e.payer,
            e.amount_gbp,
            e.currency_amount,
            e.dry_run ? 1 : 0,
            e.task_id,
            nowIso(),
          ],
        );
        return r.changes === 1; // false = already recorded (replay)
      },
      has: async (reference: string) =>
        (await db.all("SELECT 1 FROM payments_ledger WHERE reference = ?", [reference])).length > 0,
      total: async (rail: "x402" | "stripe", since: string) =>
        Number(
          (
            await db.all<{ s: number }>(
              "SELECT COALESCE(SUM(amount_gbp), 0) AS s FROM payments_ledger WHERE rail = ? AND created_at >= ?",
              [rail, since],
            )
          )[0]?.s ?? 0,
        ),
    },

    blind: {
      add: async (c: {
        entity_id: string;
        field: string;
        source: string;
        fact_value: unknown;
        fresh_value: unknown;
        agree: boolean;
      }) => {
        await db.run(
          "INSERT INTO blind_checks (entity_id, field, source, fact_value, fresh_value, agree, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            c.entity_id,
            c.field,
            c.source,
            JSON.stringify(c.fact_value),
            c.fresh_value === undefined ? null : JSON.stringify(c.fresh_value),
            c.agree ? 1 : 0,
            nowIso(),
          ],
        );
      },
      recent: async (source: string, field: string, limit: number) =>
        (
          await db.all<Row>(
            "SELECT agree FROM blind_checks WHERE source = ? AND field = ? ORDER BY id DESC LIMIT ?",
            [source, field, limit],
          )
        ).map((r) => Number(r.agree) === 1),
      summary: async () =>
        (
          await db.all<Row>(
            "SELECT source, field, COUNT(*) AS n, SUM(agree) AS ok FROM blind_checks GROUP BY source, field ORDER BY source, field",
          )
        ).map((r) => ({
          source: r.source as string,
          field: r.field as string,
          n: Number(r.n),
          agree: Number(r.ok),
        })),
    },
  };
}

export type Phase4Storage = ReturnType<typeof phase4>;
