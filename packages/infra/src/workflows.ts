import type { WorkflowDef } from "./workflow.ts";

/**
 * Every workflow the engine can run, by name. Both engines (Cloudflare and local) read this list.
 * Phase 4 adds claim-this-site fulfilment here; Milestone B adds the weekly and monthly loops.
 */
export const WORKFLOWS: WorkflowDef<never, unknown>[] = [];
