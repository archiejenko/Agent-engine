// Runtime-neutral entry: safe to import from a Cloudflare Worker (no Node-only modules).
export { type D1Like, d1Driver } from "./d1.ts";
export type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
export { type Migration, migrate, splitSqlStatements } from "./migrate.ts";
export type * from "./phase2.ts";
export type * from "./phase3.ts";
export { SqlStorage } from "./sql-storage.ts";
export type * from "./storage.ts";

import { type D1Like, d1Driver } from "./d1.ts";
import { SqlStorage } from "./sql-storage.ts";

/** D1-backed Storage. Migrations on D1 are applied by `wrangler d1 migrations apply`. */
export function createD1Storage(db: D1Like): SqlStorage {
  return new SqlStorage(d1Driver(db));
}
