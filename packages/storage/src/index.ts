// Runtime-neutral entry: safe to import from a Cloudflare Worker (no Node-only modules).

export type * from "./claims.ts";
export { type D1Like, d1Driver } from "./d1.ts";
export type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
export type * from "./graph.ts";
export type * from "./ideas.ts";
export type * from "./letters.ts";
export { type Migration, migrate, rollback, splitSqlStatements } from "./migrate.ts";
export type * from "./phase2.ts";
export type * from "./phase3.ts";
export type * from "./phase4.ts";
export type * from "./phase5.ts";
export type * from "./runtime.ts";
export { SqlStorage } from "./sql-storage.ts";
export type * from "./storage.ts";
export type * from "./v2.ts";
export type * from "./v3.ts";

import { type D1Like, d1Driver } from "./d1.ts";
import { SqlStorage } from "./sql-storage.ts";

/** D1-backed Storage. Migrations on D1 are applied by `wrangler d1 migrations apply`. */
export function createD1Storage(db: D1Like): SqlStorage {
  return new SqlStorage(d1Driver(db));
}
