import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";

/** The Durable Object SQLite storage, as far as we use it (no Workers types needed here). */
export interface DurableSqlLike {
  sql: {
    exec(
      query: string,
      ...bindings: SqlValue[]
    ): {
      toArray(): Record<string, unknown>[];
      readonly rowsWritten: number;
    };
  };
  transactionSync<T>(fn: () => T): T;
}

/**
 * A SqlDriver over a Durable Object's own SQLite (`ctx.storage`), so the run store runs the same SQL
 * inside the object as it does on a local file. Cursors are consumed straight away (the docs' rule:
 * never hold one across an await), and a batch is one `transactionSync`.
 */
export function durableSqlDriver(storage: DurableSqlLike): SqlDriver {
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: SqlValue[] = []) {
      return storage.sql.exec(sql, ...params).toArray() as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      return { changes: storage.sql.exec(sql, ...params).rowsWritten };
    },
    async batch(statements: SqlStatement[]) {
      storage.transactionSync(() => {
        for (const s of statements) storage.sql.exec(s.sql, ...(s.params ?? [])).toArray();
      });
    },
    async close() {},
  };
}
