import { type FulfilmentDeps, fulfilmentWorkflow } from "./claim.ts";
import { experimentWorkflow } from "./idea-cards.ts";
import type { WorkflowDef } from "./workflow.ts";

/**
 * Every workflow the engines can run, built with the runtime's services (storage, tools, model).
 * Both engines (Cloudflare and local) call this. Milestone B adds the weekly and monthly loops.
 */
export function buildWorkflows(d: FulfilmentDeps): WorkflowDef<never, unknown>[] {
  return [
    fulfilmentWorkflow(d) as WorkflowDef<never, unknown>,
    // v3 Phase 6: an approved idea's test, checked daily against its kill criteria.
    experimentWorkflow({ storage: d.storage, cfg: d.cfg }) as WorkflowDef<never, unknown>,
  ];
}
