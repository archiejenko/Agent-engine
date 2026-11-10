import type { SqlDriver, SqlValue } from "./driver.ts";

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const first = async (db: SqlDriver, sql: string, params: SqlValue[] = []) =>
  (await db.all<Row>(sql, params))[0] ?? null;

export interface LetterFlag {
  flag: string;
  detail: string;
}
export interface LetterRow {
  task_id: string;
  entity_id: string;
  company_name: string;
  address: string[];
  demo_slug: string;
  /** Printed on the letter: quote it by email or use the short URL to opt out. */
  opt_out_code: string;
  pdf_b64: string;
  flags: LetterFlag[];
  status: "waiting" | "batched" | "approved" | "rejected";
  batch_id: string | null;
  created_at: string;
}
export interface PrintBatchRow {
  id: string;
  week: string;
  status: "pending" | "approved" | "rejected";
  letter_count: number;
  flagged_count: number;
  created_at: string;
  decided_at: string | null;
}
export interface DemoPageRow {
  slug: string;
  entity_id: string;
  task_id: string;
  html: string;
  published: boolean;
  /** When its batch was approved; the page expires a fixed time after this. */
  published_at: string | null;
  created_at: string;
}

const letter = (r: Row, withPdf = true): LetterRow => ({
  task_id: r.task_id as string,
  entity_id: r.entity_id as string,
  company_name: r.company_name as string,
  address: JSON.parse(r.address as string) as string[],
  demo_slug: r.demo_slug as string,
  opt_out_code: (r.opt_out_code as string | null) ?? "",
  pdf_b64: withPdf ? (r.pdf_b64 as string) : "",
  flags: JSON.parse(r.flags as string) as LetterFlag[],
  status: r.status as LetterRow["status"],
  batch_id: (r.batch_id as string | null) ?? null,
  created_at: r.created_at as string,
});
const batch = (r: Row): PrintBatchRow => ({
  id: r.id as string,
  week: r.week as string,
  status: r.status as PrintBatchRow["status"],
  letter_count: Number(r.letter_count),
  flagged_count: Number(r.flagged_count),
  created_at: r.created_at as string,
  decided_at: (r.decided_at as string | null) ?? null,
});

export function lettersStorage(db: SqlDriver) {
  return {
    demoPages: {
      put: async (p: Omit<DemoPageRow, "published" | "published_at" | "created_at">) => {
        await db.run(
          "INSERT INTO demo_pages (slug, entity_id, task_id, html, published, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (slug) DO UPDATE SET html = excluded.html",
          [p.slug, p.entity_id, p.task_id, p.html, nowIso()],
        );
      },
      get: async (slug: string): Promise<DemoPageRow | null> => {
        const r = await first(db, "SELECT * FROM demo_pages WHERE slug = ?", [slug]);
        return r
          ? {
              slug: r.slug as string,
              entity_id: r.entity_id as string,
              task_id: r.task_id as string,
              html: r.html as string,
              published: Number(r.published) === 1,
              published_at: (r.published_at as string | null) ?? null,
              created_at: r.created_at as string,
            }
          : null;
      },
      setPublished: async (slugs: string[], published: boolean, at: string = nowIso()) => {
        for (const s of slugs)
          await db.run("UPDATE demo_pages SET published = ?, published_at = ? WHERE slug = ?", [
            published ? 1 : 0,
            published ? at : null,
            s,
          ]);
      },
    },
    letters: {
      put: async (l: Omit<LetterRow, "status" | "batch_id" | "created_at">) => {
        await db.run(
          "INSERT INTO letters (task_id, entity_id, company_name, address, demo_slug, opt_out_code, pdf_b64, flags, status, batch_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, ?) ON CONFLICT (task_id) DO UPDATE SET pdf_b64 = excluded.pdf_b64, flags = excluded.flags",
          [
            l.task_id,
            l.entity_id,
            l.company_name,
            JSON.stringify(l.address),
            l.demo_slug,
            l.opt_out_code,
            l.pdf_b64,
            JSON.stringify(l.flags),
            nowIso(),
          ],
        );
      },
      get: async (taskId: string): Promise<LetterRow | null> => {
        const r = await first(db, "SELECT * FROM letters WHERE task_id = ?", [taskId]);
        return r ? letter(r) : null;
      },
      /** Letters without their PDF bytes (for lists). */
      list: async (o: { status?: LetterRow["status"]; batchId?: string; limit?: number } = {}) => {
        const where: string[] = [];
        const args: SqlValue[] = [];
        if (o.status) {
          where.push("status = ?");
          args.push(o.status);
        }
        if (o.batchId) {
          where.push("batch_id = ?");
          args.push(o.batchId);
        }
        const rows = await db.all<Row>(
          `SELECT task_id, entity_id, company_name, address, demo_slug, opt_out_code, '' AS pdf_b64, flags, status, batch_id, created_at FROM letters ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, task_id LIMIT ?`,
          [...args, o.limit ?? 1000],
        );
        return rows.map((r) => letter(r, false));
      },
      /** Letters to one company (without PDF bytes), newest first. */
      forEntity: async (entityId: string): Promise<LetterRow[]> =>
        (
          await db.all<Row>(
            "SELECT task_id, entity_id, company_name, address, demo_slug, opt_out_code, '' AS pdf_b64, flags, status, batch_id, created_at FROM letters WHERE entity_id = ? ORDER BY created_at DESC",
            [entityId],
          )
        ).map((r) => letter(r, false)),
      byOptOutCode: async (code: string): Promise<LetterRow | null> => {
        const r = await first(db, "SELECT * FROM letters WHERE opt_out_code = ?", [
          code.toUpperCase(),
        ]);
        return r ? letter(r, false) : null;
      },
      pdfsForBatch: async (batchId: string): Promise<{ task_id: string; pdf_b64: string }[]> =>
        (
          await db.all<Row>(
            "SELECT task_id, pdf_b64 FROM letters WHERE batch_id = ? AND status != 'rejected' ORDER BY created_at, task_id",
            [batchId],
          )
        ).map((r) => ({ task_id: r.task_id as string, pdf_b64: r.pdf_b64 as string })),
      setStatus: async (taskIds: string[], status: LetterRow["status"], batchId?: string) => {
        for (const id of taskIds)
          await db.run(
            batchId === undefined
              ? "UPDATE letters SET status = ? WHERE task_id = ?"
              : "UPDATE letters SET status = ?, batch_id = ? WHERE task_id = ?",
            batchId === undefined ? [status, id] : [status, batchId, id],
          );
      },
      /** How many companies' registered office is exactly this address (accountant-address check). */
      sharedAddressCount: async (addressJson: string): Promise<number> => {
        const r = await first(
          db,
          "SELECT COUNT(DISTINCT entity_id) AS n FROM verified_facts WHERE field = 'registered_office_address' AND value = ?",
          [addressJson],
        );
        return Number(r?.n ?? 0);
      },
    },
    printBatches: {
      create: async (b: Omit<PrintBatchRow, "status" | "created_at" | "decided_at">) => {
        await db.run(
          "INSERT INTO print_batches (id, week, status, letter_count, flagged_count, created_at) VALUES (?, ?, 'pending', ?, ?, ?)",
          [b.id, b.week, b.letter_count, b.flagged_count, nowIso()],
        );
      },
      get: async (id: string): Promise<PrintBatchRow | null> => {
        const r = await first(db, "SELECT * FROM print_batches WHERE id = ?", [id]);
        return r ? batch(r) : null;
      },
      list: async (limit = 20): Promise<PrintBatchRow[]> =>
        (
          await db.all<Row>("SELECT * FROM print_batches ORDER BY created_at DESC LIMIT ?", [limit])
        ).map(batch),
      latest: async (): Promise<PrintBatchRow | null> => {
        const r = await first(db, "SELECT * FROM print_batches ORDER BY created_at DESC LIMIT 1");
        return r ? batch(r) : null;
      },
      decide: async (id: string, status: "approved" | "rejected") => {
        await db.run("UPDATE print_batches SET status = ?, decided_at = ? WHERE id = ?", [
          status,
          nowIso(),
          id,
        ]);
      },
    },
  };
}

export type LettersStorage = ReturnType<typeof lettersStorage>;
