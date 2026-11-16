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
    // No repeated external actions (v2 rule 17): an external call is recorded BEFORE it runs. A retried
    // or resumed step with the same task, tool and arguments gets the first result back, or is refused
    // while the first attempt's outcome is unknown (until a person checks, or the tool confirms it didn't
    // happen). A dry run and a live run of the same call are different effects.
    let effectKey: string | null = null;
    if (reg.external) {
      effectKey = await effectKeyFor(ctx.task.task_id, name, args, dryRun);
      const prior = await this.storage.effects.get(effectKey);
      if (prior?.status === "done") {
        this.calls.push({ tool: name, args, result: prior.result, blocked: false, error: null });
        return { result: prior.result, untrusted: false, dry_run: prior.dry_run };
      }
      if (prior && prior.status !== "not_happened")
        await refuse(
          `an earlier attempt's outcome is unknown (${prior.status}); not repeating it until someone checks`,
          false,
        );
      if (prior?.status === "not_happened")
        await this.storage.effects.finish(effectKey, "unknown", null, "retrying");
      else
        await this.storage.effects.start({
          key: effectKey,
          task_id: ctx.task.task_id,
          tool: name,
          dry_run: dryRun,
        });
    }
    try {
      const out = await t.handler(args, { task: ctx.task, dryRun });
      if (effectKey) await this.storage.effects.finish(effectKey, "done", out.result);
      if (reg.cost_gbp_per_call > 0)
        await this.storage.tasks.addCost(ctx.task.task_id, reg.cost_gbp_per_call);
      this.calls.push({ tool: name, args, result: out.result, blocked: false, error: null });
      return { result: out.result, untrusted: out.untrusted ?? false, dry_run: dryRun };
    } catch (e) {
      // We can't tell whether the action happened before the error: leave it for a person to check.
      if (effectKey)
        await this.storage.effects.finish(effectKey, "unknown", null, (e as Error).message);
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

/** Stable key for one external call: task + tool + canonical arguments + dry-run flag. */
export async function effectKeyFor(taskId: string, tool: string, args: unknown, dryRun: boolean) {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
          )
        : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canon(args)) ?? "null");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${taskId}:${tool}:${dryRun ? "dry" : "live"}:${hash}`;
}
