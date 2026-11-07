import { defaultContext, rollbackRun } from "@ae/verification";
import { log, openDb } from "./lib.ts";

// Roll back a run by its run_id: its claims stop counting and affected facts are recomputed.
const runId = process.argv[2];
if (!runId) {
  console.error("Usage: pnpm rollback <run_id>");
  process.exit(1);
}
const storage = await openDb();
log(JSON.stringify(await rollbackRun(storage, defaultContext(), runId)));
await storage.close();
