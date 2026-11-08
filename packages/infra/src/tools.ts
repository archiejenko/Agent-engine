import type { InfraConfig } from "@ae/config";
import { type Role, ToolRegistration } from "@ae/contracts";
import type { Storage, StoredTask } from "@ae/storage";
import { externalActionsAllowed } from "./controls.ts";

/**
 * Tool registry. Every tool call goes through `call`, which enforces (in code, not prompts):
 * - the tool is listed for this playbook step;
 * - the role is allowed (only the operator may call external tools — guardrail 4);
 * - the task's lane is allowed (a licensed task can't call external/customer-serving tools — guardrail 1);
 * - kill switches: when external actions are off, external tools run in DRY-RUN (guardrail 7);
 * - per-tool rate limit; cost per call is added to the task.
 * A blocked call throws ToolBlockedError and is logged.
 */
export interface ToolContext {
  task: StoredTask;
  role: Role;
  step_tools: string[];
}

export interface ToolResult {
  result: unknown;
  /** Untrusted results (fetched pages, emails) never reach the operator role. */
  untrusted: boolean;
  dry_run: boolean;
}

export type ToolHandler = (
  args: unknown,
  env: { task: StoredTask; dryRun: boolean },
) => Promise<{ result: unknown; untrusted?: boolean }>;

export class ToolBlockedError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: string,
  ) {
    super(`tool ${tool} blocked: ${reason}`);
  }
}

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  result: unknown;
  blocked: boolean;
  error: string | null;
}

export class ToolRegistry {
  private readonly tools = new Map<string, { reg: ToolRegistration; handler: ToolHandler }>();
  private readonly recent = new Map<string, number[]>();
  readonly calls: ToolCallRecord[] = [];

  constructor(
    private readonly storage: Storage,
    private readonly cfg: InfraConfig,
    private readonly now: () => number = Date.now,
  ) {}

  register(reg: ToolRegistration, handler: ToolHandler) {
    const r = ToolRegistration.parse(reg); // contract guardrails (external ⇒ operator-only, no licensed)
    this.tools.set(r.name, { reg: r, handler });
  }

  get(name: string) {
    return this.tools.get(name)?.reg ?? null;
  }

  /** Called on a guardrail breach (a call outside the rules), before the call is refused. */
  onBreach:
    | ((d: { playbook: string; task_id: string; tool: string; reason: string }) => Promise<void>)
    | null = null;

  async call(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.tools.get(name);
    const refuse = async (reason: string, breach: boolean): Promise<never> => {
      this.calls.push({ tool: name, args, result: null, blocked: true, error: reason });
      if (breach && this.onBreach)
        await this.onBreach({
          playbook: ctx.task.playbook,
          task_id: ctx.task.task_id,
          tool: name,
          reason,
        });
      throw new ToolBlockedError(name, reason);
    };
    if (!t) return refuse("not registered", true);
    const { reg } = t;
    if (!ctx.step_tools.includes(name)) await refuse("not listed for this playbook step", true);
    if (!reg.allowed_roles.includes(ctx.role))
      await refuse(`role ${ctx.role} may not call it`, true);
    if (!reg.allowed_lanes.includes(ctx.task.lane))
      await refuse(`lane ${ctx.task.lane} not allowed`, true);
    if (ctx.task.lane === "licensed" && (reg.external || reg.serves_customer))
      await refuse("licensed tasks can't act externally or serve customers", true);
    const window = (this.recent.get(name) ?? []).filter((x) => this.now() - x < 60_000);
    if (window.length >= reg.rate_limit_per_min) await refuse("rate limit", false);
    window.push(this.now());
    this.recent.set(name, window);

    const dryRun = reg.external
      ? !(await externalActionsAllowed(this.storage, this.cfg, ctx.task.playbook))
      : false;
    try {
      const out = await t.handler(args, { task: ctx.task, dryRun });
      if (reg.cost_gbp_per_call > 0)
        await this.storage.tasks.addCost(ctx.task.task_id, reg.cost_gbp_per_call);
      this.calls.push({ tool: name, args, result: out.result, blocked: false, error: null });
      return { result: out.result, untrusted: out.untrusted ?? false, dry_run: dryRun };
    } catch (e) {
      this.calls.push({
        tool: name,
        args,
        result: null,
        blocked: false,
        error: (e as Error).message,
      });
      throw e;
    }
  }

  drainCalls(): ToolCallRecord[] {
    return this.calls.splice(0);
  }
}
