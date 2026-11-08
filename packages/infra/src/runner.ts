import type { InfraConfig, ModelsConfig } from "@ae/config";
import type { Role } from "@ae/contracts";
import { costGbp, type ModelClient } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { checkSpend, queuePaused, SpendCapError } from "./controls.ts";
import type { LoadedPlaybook } from "./playbook.ts";
import type { ToolCallRecord, ToolRegistry, ToolResult } from "./tools.ts";

/**
 * Executes a task through its playbook: each role step gets ONLY the tools its step lists, outputs
 * are checked before continuing, a failed check retries the producing step once with the reason and
 * then stops for review, gates pause for Archie. Every step is logged with tokens and cost.
 */
export interface RoleStepContext {
  task: StoredTask;
  stepId: string;
  role: Role;
  /** Outputs of earlier steps, keyed by their output name. Never contains raw untrusted content. */
  inputs: Record<string, unknown>;
  /** Raw untrusted tool results from THIS step (never given to the operator). */
  tools: { call(name: string, args: unknown): Promise<ToolResult> };
  model: ModelClient;
  examples: { original: string; edited: string }[];
  retryReason: string | null;
  dryRunExternal?: boolean;
}

export interface RoleStepResult {
  output: unknown;
  model?: string | null;
  usage?: { input_tokens: number; output_tokens: number };
  check?: { passed: boolean; reasons: string[] };
}

export type RoleImpl = (ctx: RoleStepContext) => Promise<RoleStepResult>;

export interface PlaybookImpl {
  roles: Record<string, RoleImpl>;
  /** Text Archie sees at a gate, and how an edit replaces it. */
  gateItem(state: TaskState): unknown;
  applyEdit?(state: TaskState, edited: string): void;
}

export interface TaskState {
  next_step: number;
  outputs: Record<string, unknown>;
  retried: string[];
  attempts: number;
  awaiting?: { step_id: string; item: unknown; kind: "gate" | "check_failed" };
}

export interface RunnerDeps {
  storage: Storage;
  infra: InfraConfig;
  models: ModelsConfig;
  model: ModelClient;
  tools: ToolRegistry;
  playbooks: Map<string, LoadedPlaybook>;
  impls: Map<string, PlaybookImpl>;
  now?: () => Date;
}

async function hash01(text: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return ((h[0] as number) * 256 + (h[1] as number)) / 65536;
}

const initialState = (): TaskState => ({ next_step: 0, outputs: {}, retried: [], attempts: 0 });

export class PlaybookRunner {
  constructor(private readonly d: RunnerDeps) {}

  private now() {
    return this.d.now ? this.d.now() : new Date();
  }

  private async load(taskId: string) {
    const task = await this.d.storage.tasks.get(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    const pb = this.d.playbooks.get(task.playbook);
    const impl = this.d.impls.get(task.playbook);
    if (!pb || !impl) throw new Error(`playbook ${task.playbook} not loaded`);
    if (pb.spec.version !== task.playbook_version)
      throw new Error(
        `task needs ${task.playbook} v${task.playbook_version}, loaded v${pb.spec.version}`,
      );
    const state: TaskState = { ...initialState(), ...(task.state as Partial<TaskState>) };
    return { task, pb, impl, state };
  }

  /** Run until done, a gate, a failure, or a review stop. */
  async run(taskId: string): Promise<StoredTask> {
    if (await queuePaused(this.d.storage))
      throw new Error("queue is paused (spend cap or manual pause)");
    const { task, pb, impl, state } = await this.load(taskId);
    if (
      task.status === "done" ||
      task.status === "cancelled" ||
      task.status === "awaiting_approval"
    )
      return task;
    await this.d.storage.tasks.update(task.task_id, { status: "running" });

    const steps = pb.spec.steps;
    try {
      while (state.next_step < steps.length) {
        const step = steps[state.next_step] as (typeof steps)[number];
        if ("gate" in step) {
          // Autonomy is set per playbook (never per run): L3 skips the gate; L2 gates a sample only.
          const sampled = (await hash01(task.task_id)) < this.d.infra.autonomy.l2_review_sample;
          if (
            state.outputs.approved === true ||
            task.autonomy === "L3" ||
            (task.autonomy === "L2" && !sampled)
          ) {
            state.next_step++;
            continue;
          }
          state.awaiting = { step_id: step.id, item: impl.gateItem(state), kind: "gate" };
          await this.d.storage.tasks.update(task.task_id, {
            status: "awaiting_approval",
            state: state as unknown as Record<string, unknown>,
          });
          return (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
        }
        if (step.role === "operator" && task.autonomy === "L0") {
          // L0 = draft only: operator (acting) steps never run.
          state.outputs[step.output] = { skipped: "L0: draft only" };
          state.next_step++;
          continue;
        }
        const res = await this.execStep(task, pb, impl, state, state.next_step, null);
        if (res.check && !res.check.passed) {
          // Retry the step that produced the checked output, once, with the reasons.
          const producerIdx = state.next_step - 1;
          const producer = steps[producerIdx];
          if (producer && "role" in producer && !state.retried.includes(producer.id)) {
            state.retried.push(producer.id);
            await this.execStep(task, pb, impl, state, producerIdx, res.check.reasons.join("; "));
            const again = await this.execStep(task, pb, impl, state, state.next_step, null);
            if (again.check?.passed) {
              state.next_step++;
              continue;
            }
            res.check = again.check;
          }
          state.awaiting = {
            step_id: step.id,
            kind: "check_failed",
            item: { reasons: res.check?.reasons ?? [], draft: impl.gateItem(state) },
          };
          await this.d.storage.tasks.update(task.task_id, {
            status: "awaiting_approval",
            state: state as unknown as Record<string, unknown>,
          });
          await this.d.storage.alerts.raise(
            "check_failed",
            `Task ${task.task_id} failed its check twice; waiting for review`,
            res.check,
          );
          return (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
        }
        state.next_step++;
        await this.d.storage.tasks.update(task.task_id, {
          state: state as unknown as Record<string, unknown>,
        });
      }
      await this.d.storage.tasks.update(task.task_id, {
        status: "done",
        state: state as unknown as Record<string, unknown>,
      });
    } catch (e) {
      const transient =
        !(e instanceof SpendCapError) && /timeout|ECONN|429|5\d\d/.test((e as Error).message);
      state.attempts++;
      const failed = !transient || state.attempts >= this.d.infra.max_attempts;
      await this.d.storage.tasks.update(task.task_id, {
        status: failed ? "failed" : "queued",
        error: (e as Error).message.slice(0, 500),
        state: state as unknown as Record<string, unknown>,
      });
      if (!failed) return (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
    }
    return (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
  }

  private async execStep(
    task: StoredTask,
    pb: LoadedPlaybook,
    impl: PlaybookImpl,
    state: TaskState,
    idx: number,
    retryReason: string | null,
  ): Promise<RoleStepResult> {
    const step = pb.spec.steps[idx];
    if (!step || !("role" in step)) throw new Error(`step ${idx} is not a role step`);
    const roleImpl = impl.roles[step.id];
    if (!roleImpl) throw new Error(`no implementation for step ${step.id}`);
    const fresh = (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
    await checkSpend(this.d.storage, this.d.infra, fresh, 0, this.now());

    const untrustedSeen: ToolCallRecord[] = [];
    const started = Date.now();
    const ctx: RoleStepContext = {
      task: fresh,
      stepId: step.id,
      role: step.role,
      // The operator never receives raw fetched content: inputs are step OUTPUTS only, and
      // untrusted tool results are kept inside the step that fetched them.
      inputs: { ...state.outputs },
      tools: {
        call: async (name, args) => {
          const r = await this.d.tools.call(name, args, {
            task: fresh,
            role: step.role,
            step_tools: step.tools,
          });
          if (r.untrusted)
            untrustedSeen.push({
              tool: name,
              args,
              result: "[untrusted content withheld from log]",
              blocked: false,
              error: null,
            });
          return r;
        },
      },
      model: this.d.model,
      examples: (await this.d.storage.examples.list(task.playbook, step.id, 3)).map((e) => ({
        original: e.original,
        edited: e.edited,
      })),
      retryReason,
    };
    const res = await roleImpl(ctx);
    const usage = res.usage ?? { input_tokens: 0, output_tokens: 0 };
    const price = res.model
      ? (this.d.models.prices[res.model] ?? this.d.models.prices["fake-model"])
      : undefined;
    const cost = price ? costGbp(usage, price, this.d.models.usd_to_gbp) : 0;
    if (cost > 0) await checkSpend(this.d.storage, this.d.infra, fresh, cost, this.now());
    state.outputs[step.output] = res.output;
    const calls = this.d.tools
      .drainCalls()
      .map((c) =>
        untrustedSeen.some((u) => u.tool === c.tool)
          ? { ...c, result: "[untrusted content withheld from log]" }
          : c,
      );
    await this.d.storage.runLog.append({
      task_id: task.task_id,
      step_id: retryReason ? `${step.id}` : step.id,
      role: step.role,
      model: res.model ?? null,
      tool_calls: calls as never,
      output: (res.output ?? null) as never,
      check_result: res.check ?? null,
      tokens: { input: usage.input_tokens, output: usage.output_tokens },
      cost_gbp: cost,
      duration_ms: Date.now() - started,
      timestamp: this.now().toISOString(),
    });
    if (cost > 0) await this.d.storage.tasks.addCost(task.task_id, cost);
    return res;
  }

  /** Archie's decision at a gate: approve / edit / reject. Edits become playbook examples. */
  async decide(
    taskId: string,
    decision: "approve" | "edit" | "reject",
    editedText: string | null = null,
  ): Promise<StoredTask> {
    const { task, impl, state } = await this.load(taskId);
    if (task.status !== "awaiting_approval" || !state.awaiting)
      throw new Error(`task ${taskId} isn't waiting for approval`);
    if (decision === "edit" && !editedText) throw new Error("an edit needs the edited text");
    const awaiting = state.awaiting;
    await this.d.storage.approvals.add({
      task_id: task.task_id,
      step_id: awaiting.step_id,
      item_shown: awaiting.item,
      decision,
      edited_text: decision === "edit" ? editedText : null,
    });
    if (decision === "edit") {
      const original = JSON.stringify(impl.gateItem(state));
      impl.applyEdit?.(state, editedText as string);
      await this.d.storage.examples.add({
        playbook: task.playbook,
        step_id: "draft",
        task_id: task.task_id,
        original,
        edited: editedText as string,
      });
    }
    delete state.awaiting;
    if (decision === "reject") {
      await this.d.storage.tasks.update(task.task_id, {
        status: "cancelled",
        state: state as unknown as Record<string, unknown>,
      });
      return (await this.d.storage.tasks.get(task.task_id)) as StoredTask;
    }
    // Approve/edit: continue after the gate (a check_failed stop resumes at the gate itself).
    const gateIdx = (await this.load(taskId)).pb.spec.steps.findIndex(
      (s) => s.id === awaiting.step_id,
    );
    state.next_step =
      awaiting.kind === "gate"
        ? gateIdx + 1
        : (await this.load(taskId)).pb.spec.steps.findIndex((s) => "gate" in s) + 1;
    state.outputs.approved = true;
    await this.d.storage.tasks.update(task.task_id, {
      status: "queued",
      state: state as unknown as Record<string, unknown>,
    });
    return this.run(taskId);
  }

  /** Stuck tasks time out to failed with a reason. */
  async timeoutStuck(): Promise<number> {
    const cutoff = new Date(
      this.now().getTime() - this.d.infra.task_timeout_minutes * 60_000,
    ).toISOString();
    const stuck = await this.d.storage.tasks.stuck(cutoff);
    for (const t of stuck)
      await this.d.storage.tasks.update(t.task_id, {
        status: "failed",
        error: `timed out after ${this.d.infra.task_timeout_minutes} minutes`,
      });
    return stuck.length;
  }
}
