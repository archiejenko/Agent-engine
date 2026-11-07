import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
import { migrate } from "./migrate.ts";
import { loadMigrations } from "./migrations-fs.ts";
import { SqlStorage } from "./sql-storage.ts";

/** Node only. Local SQLite file (or ":memory:" for tests). */
export function sqliteDriver(path: string): SqlDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes };
    },
    async batch(statements: SqlStatement[]) {
      const tx = db.transaction((stmts: SqlStatement[]) => {
        for (const s of stmts) db.prepare(s.sql).run(...(s.params ?? []));
      });
      tx(statements);
    },
    async close() {
      db.close();
    },
  };
}

/** Open (and migrate) a SQLite-backed Storage. */
export async function openSqliteStorage(path: string): Promise<SqlStorage> {
  const driver = sqliteDriver(path);
  await migrate(driver, loadMigrations());
  return new SqlStorage(driver);
}
