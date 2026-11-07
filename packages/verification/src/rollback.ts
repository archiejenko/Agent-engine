import type { Storage } from "@ae/storage";
import type { VerificationContext } from "./context.ts";
import { rebuildFacts } from "./persist.ts";

/**
 * Roll back a run (guardrail 8): its claims are superseded, its observations and fact versions stop
 * counting, and every fact it touched is recomputed from what remains. Nothing is deleted.
 */
export async function rollbackRun(storage: Storage, ctx: VerificationContext, runId: string) {
  const run = await storage.runs.get(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status === "rolled_back") throw new Error(`run ${runId} is already rolled back`);
  const pairs = await storage.claims.touchedByRun(runId);
  const claims = await storage.claims.listByRun(runId);
  const rb = await storage.runs.start({
    kind: "rollback",
    config_versions: { rolled_back: runId },
  });
  await storage.claims.supersede(
    claims.map((c) => c.claim_id),
    `rolled back run ${runId}`,
    rb.run_id,
  );
  await storage.runs.finish(runId, "rolled_back");
  const stats = await rebuildFacts(storage, ctx, pairs, {
    run_id: rb.run_id,
    now: new Date().toISOString(),
  });
  await storage.runs.finish(rb.run_id, "succeeded");
  return { rollback_run_id: rb.run_id, facts_affected: pairs.length, ...stats };
}
