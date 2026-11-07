import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";

/** Structural subset of Cloudflare's D1Database, so this package doesn't need Workers types. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes?: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

export function d1Driver(db: D1Like): SqlDriver {
  const prep = (sql: string, params: SqlValue[] = []) => db.prepare(sql).bind(...params);
  return {
    dialect: "d1",
    async all<T>(sql: string, params?: SqlValue[]) {
      const r = await prep(sql, params).all<T>();
      return r.results;
    },
    async run(sql: string, params?: SqlValue[]) {
      const r = await prep(sql, params).run();
      return { changes: r.meta.changes ?? 0 };
    },
    async batch(statements: SqlStatement[]) {
      if (statements.length === 0) return;
      // D1 batches run as a single transaction.
      await db.batch(statements.map((s) => prep(s.sql, s.params)));
    },
    async close() {},
  };
}
