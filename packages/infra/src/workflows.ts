import { type FulfilmentDeps, fulfilmentWorkflow } from "./claim.ts";
import type { WorkflowDef } from "./workflow.ts";

/**
 * Every workflow the engines can run, built with the runtime's services (storage, tools, model).
 * Both engines (Cloudflare and local) call this. Milestone B adds the weekly and monthly loops.
 */
export function buildWorkflows(d: FulfilmentDeps): WorkflowDef<never, unknown>[] {
  return [fulfilmentWorkflow(d) as WorkflowDef<never, unknown>];
}
