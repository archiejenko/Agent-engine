// Runtime-neutral entry: safe to import from a Cloudflare Worker (no Node-only modules).

export {
  type BlobStore,
  memoryBlobStore,
  type R2Like,
  r2BlobStore,
} from "./blobs.ts";
export type * from "./claims.ts";
export { type D1Like, d1Driver } from "./d1.ts";
export { type DurableSqlLike, durableSqlDriver } from "./do-sql.ts";
export type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
export type * from "./graph.ts";
export type * from "./idea-matrix.ts";
export type * from "./ideas.ts";
export type * from "./letters.ts";
export { type Migration, migrate, rollback, splitSqlStatements } from "./migrate.ts";
export type * from "./phase2.ts";
export type * from "./phase3.ts";
export type * from "./phase4.ts";
export type * from "./phase5.ts";
export {
  CrossStoreError,
  D1_STORES,
  type D1Store,
  MOVED_OUT_OF_CORE,
  PLACEMENT,
  routedDriver,
  type Store,
  storeOf,
  tablesIn,
} from "./placement.ts";
export {
  type NodeFinish,
  RUN_STORE_SCHEMA,
  type RunArchive,
  type RunCloseResult,
  type RunStore,
  runArchive,
  runArchiveKey,
  type StateValueRow,
  sqlRunStore,
} from "./run-store.ts";
export type * from "./runtime.ts";
export { SqlStorage } from "./sql-storage.ts";
export type * from "./storage.ts";
export type * from "./v2.ts";
export type * from "./v3.ts";

import { type D1Like, d1Driver } from "./d1.ts";
import { routedDriver } from "./placement.ts";
import { SqlStorage } from "./sql-storage.ts";

/**
 * D1-backed Storage over the three databases (data layer plan, step 2): DB (core), FACTS and TELEMETRY.
 * Migrations on D1 are applied by `wrangler d1 migrations apply` per database.
 */
export function createD1Storage(d: { core: D1Like; facts: D1Like; telemetry: D1Like }): SqlStorage {
  return new SqlStorage(
    routedDriver({
      core: d1Driver(d.core),
      facts: d1Driver(d.facts),
      telemetry: d1Driver(d.telemetry),
    }),
  );
}
