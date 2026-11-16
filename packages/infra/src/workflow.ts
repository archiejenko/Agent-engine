import type { InfraConfig } from "@ae/config";
import type { Storage, WorkflowInstanceRow } from "@ae/storage";
import { externalActionsAllowed } from "./controls.ts";

/**
 * Workflows (v2 Phase 2): multi-step work over time (fulfilment, experiments, weekly loops). One step
 * contract, two engines:
 * - Cloudflare Workflows in production (apps/api/src/workflows.ts adapts `step.do` / `step.sleep`);
 * - LocalWorkflowEngine for local runs and tests, which persists every completed step in
 *   `workflow_steps` so a resumed instance replays them instead of running them again.
 *
 * Kill switch: an instance is LIVE if external actions were allowed for its playbook when it started,
 * otherwise DRY-RUN (its external tool calls are simulated by the tool registry). A live instance checks
 * the switch before EVERY step and pauses there while it's on, so turning the switch on stops it within
 * one step and it never quietly turns into a dry run halfway through (a paid customer must not get a
 * simulated fulfilment). Dry-run instances can't act externally, so they carry on.
 *
 * Step outputs must be JSON-serialisable; step names must be unique within an instance and stable.
 */
export interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
}

export interface WorkflowContext {
  instanceId: string;
  dryRun: boolean;
}

export interface WorkflowDef<P = unknown, R = unknown> {
  name: string;
  /** Kill-switch scope (the playbook's own switch and the global one). */
  playbook: string;
  run(params: P, step: WorkflowStep, ctx: WorkflowContext): Promise<R>;
}

/** May a step of this instance run now? Dry-run instances always; live ones only with external actions on. */
export async function workflowMayProceed(
  storage: Storage,
  cfg: InfraConfig,
  inst: Pick<WorkflowInstanceRow, "playbook" | "dry_run">,
): Promise<boolean> {
  if (inst.dry_run) return true;
  return externalActionsAllowed(storage, cfg, inst.playbook ?? "workflow");
}

class Halt extends Error {
  constructor(
    readonly status: "paused" | "sleeping",
    readonly reason: string,
    readonly wakeAt: string | null = null,
  ) {
    super(reason);
  }
}

export class LocalWorkflowEngine {
  private readonly defs = new Map<string, WorkflowDef<never, unknown>>();

  constructor(
    private readonly storage: Storage,
    private readonly cfg: InfraConfig,
    defs: WorkflowDef<never, unknown>[],
    private readonly now: () => Date = () => new Date(),
    private readonly retries = 3,
  ) {
    for (const d of defs) this.defs.set(d.name, d);
  }

  /** Starts an instance (idempotent on `id`) and runs it as far as it can go. */
  async start<P>(
    workflow: string,
    params: P,
    o: { id?: string; synthetic?: boolean } = {},
  ): Promise<WorkflowInstanceRow> {
    const def = this.defs.get(workflow);
    if (!def) throw new Error(`unknown workflow ${workflow}`);
    const id = o.id ?? crypto.randomUUID();
    if (!(await this.storage.workflows.get(id)))
      await this.storage.workflows.create({
        id,
        workflow,
        playbook: def.playbook,
        params,
        dry_run: !(await externalActionsAllowed(this.storage, this.cfg, def.playbook)),
        synthetic: o.synthetic,
      });
    return this.advance(id);
  }

  /** Runs (or resumes) an instance: completed steps replay from storage, the rest run in order. */
  async advance(id: string): Promise<WorkflowInstanceRow> {
    const inst = await this.storage.workflows.get(id);
    if (!inst) throw new Error(`no workflow instance ${id}`);
    if (inst.status === "complete" || inst.status === "errored") return inst;
    const def = this.defs.get(inst.workflow);
    if (!def) throw new Error(`unknown workflow ${inst.workflow}`);
    await this.storage.workflows.update(id, {
      status: "running",
      pause_reason: null,
      wake_at: null,
    });
    const step: WorkflowStep = {
      do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const done = await this.storage.workflows.step(id, name);
        if (done) return done.output as T;
        if (!(await workflowMayProceed(this.storage, this.cfg, inst)))
          throw new Halt("paused", `kill switch on (before step "${name}")`);
        let last: unknown;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          try {
            const out = await fn();
            await this.storage.workflows.putStep(id, name, out ?? null);
            return out;
          } catch (e) {
            if (e instanceof Halt) throw e;
            last = e;
          }
        }
        throw last;
      },
      sleep: async (name: string, ms: number) => {
        const key = `sleep:${name}`;
        if (await this.storage.workflows.step(id, key)) return;
        const startKey = `sleep-start:${name}`;
        const started = await this.storage.workflows.step(id, startKey);
        const wake = started
          ? (started.output as string)
          : new Date(this.now().getTime() + ms).toISOString();
        if (!started) await this.storage.workflows.putStep(id, startKey, wake);
        if (this.now().toISOString() < wake)
          throw new Halt("sleeping", `sleeping until ${wake}`, wake);
        await this.storage.workflows.putStep(id, key, wake);
      },
    };
    try {
      const output = await def.run(inst.params as never, step, {
        instanceId: id,
        dryRun: inst.dry_run,
      });
      await this.storage.workflows.update(id, { status: "complete", output: output ?? null });
    } catch (e) {
      if (e instanceof Halt)
        await this.storage.workflows.update(id, {
          status: e.status,
          pause_reason: e.reason,
          wake_at: e.wakeAt,
        });
      else
        await this.storage.workflows.update(id, { status: "errored", error: (e as Error).message });
    }
    return (await this.storage.workflows.get(id)) as WorkflowInstanceRow;
  }

  /** Resumes sleeping instances that are due, and paused ones whose kill switch is now off. */
  async tick(): Promise<number> {
    let n = 0;
    for (const inst of await this.storage.workflows.due(this.now().toISOString())) {
      if (!this.defs.has(inst.workflow)) continue;
      if (inst.status === "paused" && !(await workflowMayProceed(this.storage, this.cfg, inst)))
        continue;
      await this.advance(inst.id);
      n++;
    }
    return n;
  }
}
