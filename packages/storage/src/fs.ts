// Node-only storage helpers (never imported by a Worker).
import { join } from "node:path";
import { fsBlobStore } from "./blobs-fs.ts";
import { sqlRunStore } from "./run-store.ts";
import { sqliteDriver } from "./sqlite.ts";

export { fsBlobStore };

/**
 * Local graph run state (data layer plan, step 1): `runs.sqlite` beside the main database, and closed
 * runs archived under `blobs/`. The same run-store code the RunState Durable Object runs on Cloudflare.
 */
export function localRunState(dataDir: string) {
  const blobs = fsBlobStore(join(dataDir, "blobs"));
  return { runs: sqlRunStore(sqliteDriver(join(dataDir, "runs.sqlite")), blobs), blobs };
}
