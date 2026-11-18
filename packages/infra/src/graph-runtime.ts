import {
  type GraphPolicy,
  type InfraConfig,
  loadInfraPricesConfig,
  type ModelsConfig,
} from "@ae/config";
import { type CompiledGraph, type GraphNode, graphEventType } from "@ae/contracts";
import {
  type Bindings,
  GraphPausedError,
  type NodeContext,
  type NodeOutcome,
  newRunState,
  priceModelCall,
  type RunState,
  runGraph,
} from "@ae/graph";
import type { Storage, StoredRunLog, StoredTask } from "@ae/storage";
import { K, queuePaused } from "./controls.ts";
import { legacyBindings } from "./graph-legacy.ts";
import type { PlaybookRunner } from "./runner.ts";
import type { WorkflowDef, WorkflowPort, WorkflowStep } from "./workflow.ts";

/**
 * The graph runtime (graph plan, G2), behind GRAPH_ENGINE_ENABLED. ONE workflow definition, `graph_run`,
 * interprets any compiled graph (Cloudflare: GraphRunWorkflow; locally: the persisted-step engine):
 * - every node runs inside a named step (`${nodeId}#${iteration}`), so a replay never repeats work;
 * - role nodes are dispatched as `graph_node` jobs (the queue on Cloudflare) and the run waits for
 *   `gd-<run>-<node>-<iter>`; the job runs the SAME step code and records cost events;
 * - approvals wait for `ga-<run>-<node>-<iter>` (sent when Archie decides in Needs you). A timeout takes
 *   the safe default: nothing is sent, recorded as "defaulted" (rule 19);
 * - before every node: queue pause, the playbook's own kill switch, the graph's budget and the agent
 *   pool. Any of them pauses the run (and alerts); it resumes when cleared.
 * External tools still go through the tool registry: dry-run while the global kill switch is on, and
 * recorded before they run, so a retried step never repeats one (v2 rule 17).
 */
export const GRAPH_WORKFLOW = "graph_run";

export interface GraphRunParams {
  run_id: string;
  task_id: string;
  graph_id: string;
  version: number;
}

export interface GraphNodeJob {
  kind: "graph_node";
  run_id: string;
  task_id: string;
  graph_id: string;
  version: number;
  node_id: string;
  iteration: number;
  instance_id: string;
}

export interface GraphRuntimeDeps {
  storage: Storage;
  cfg: InfraConfig;
  policy: GraphPolicy;
  models: ModelsConfig;
  runner: PlaybookRunner;
  /** Sends a graph_node job (the queue on Cloudflare; an in-process list locally). */
  dispatch(job: GraphNodeJob): Promise<void>;
  /** Price per call of a registered tool (cost events for free tools record zero). */
  toolPrice(tool: string): number;
  /** True when node spend is real money (a live model); the pool is enforced only then. */
  realSpend: boolean;
}

const NODE_TIMEOUT_MS = (p: GraphPolicy, n: GraphNode) =>
  Math.min(
    n.budget.maxDurationS + p.runtime.role_node_timeout_margin_s,
    p.runtime.role_node_timeout_max_s,
  ) * 1000;

export async function loadCompiled(
  storage: Storage,
  graphId: string,
  version: number,
): Promise<CompiledGraph> {
  const row = await storage.graphSpecs.get(graphId, version);
  if (!row?.compiled) throw new Error(`graph ${graphId}@${version} isn't compiled`);
  return row.compiled as CompiledGraph;
}

/** Agent pool: Archie's top-ups + realised profit (settled, non-test revenue − all real recorded costs). */
export async function poolBalance(storage: Storage): Promise<number> {
  const all = { from: "1970-01-01T00:00:00.000Z", to: "9999-12-31T00:00:00.000Z" };
  const topups = (await storage.poolEvents.list()).reduce((a, e) => a + e.amount_gbp, 0);
  const revenue = (await storage.revenueEvents.range(all))
    .filter((r) => !r.test_mode)
    .reduce((a, r) => a + r.amount_gbp, 0);
  const costs = (await storage.costEvents.range(all))
    .filter((c) => !c.synthetic)
    .reduce((a, c) => a + c.amount_gbp, 0);
  return topups + revenue - costs;
}

/** Why the next node may not run, or null. */
export async function pauseReason(
  d: GraphRuntimeDeps,
  task: StoredTask,
  compiled: CompiledGraph,
  runId: string,
  node: GraphNode,
): Promise<string | null> {
  if (await queuePaused(d.storage)) return "the task queue is paused";
  if ((await d.storage.controls.get<boolean>(K.playbook(task.playbook))) === true)
    return `${task.playbook}'s kill switch is on`;
  const run = await d.storage.graphRuns.get(runId);
  if (run && run.cost_so_far_gbp + node.budget.maxCostGbp > compiled.spec.budgetGbp + 1e-9)
    return `the graph's budget (£${compiled.spec.budgetGbp.toFixed(2)}) would be exceeded`;
  if (
    d.realSpend &&
    node.budget.maxCostGbp > 0 &&
    (await poolBalance(d.storage)) < node.budget.maxCostGbp
  )
    return "the agent pool is empty";
  return null;
}

/**
 * Cost events for one finished step: exactly one per model call and one per tool call, plus the step's
 * infra allocation. Fake-model calls are recorded but marked synthetic (not real money).
 */
export async function recordStepCosts(
  d: Pick<GraphRuntimeDeps, "storage" | "models" | "toolPrice">,
  o: {
    entry: StoredRunLog;
    task: StoredTask;
    run_id: string | null;
    graph_id: string | null;
    graph_version: number | null;
    node_id: string | null;
    shape: string | null;
    mode: "live" | "sandbox" | "probe" | "planner";
    dry_run: boolean;
  },
): Promise<number> {
  const at = new Date().toISOString();
  const base = {
    at,
    run_id: o.run_id,
    graph_id: o.graph_id,
    graph_version: o.graph_version,
    node_id: o.node_id,
    task_id: o.task.task_id,
    opportunity_id: o.task.source_ref.match(/^opportunity:([^:]+)/)?.[1] ?? null,
    revenue_path: o.task.revenue_path,
    shape_fingerprint: o.shape,
    mode: o.mode,
    price_table_version: d.models.price_table_version,
    dry_run: o.dry_run,
  };
  let total = 0;
  if (o.entry.model) {
    const priced = priceModelCall(
      o.entry.model,
      { input_tokens: o.entry.tokens.input, output_tokens: o.entry.tokens.output },
      d.models,
    );
    await d.storage.costEvents.add({
      ...base,
      event_id: crypto.randomUUID(),
      category: "model",
      unit: "model_call",
      quantity: 1,
      unit_price_gbp: priced.total_gbp,
      amount_gbp: priced.total_gbp,
      synthetic: o.entry.model === "fake-model",
    });
    total += o.entry.model === "fake-model" ? 0 : priced.total_gbp;
  }
  for (const c of o.entry.tool_calls) {
    if (c.blocked) continue;
    const price = d.toolPrice(c.tool);
    await d.storage.costEvents.add({
      ...base,
      event_id: crypto.randomUUID(),
      category: "tool",
      unit: `call:${c.tool}`,
      quantity: 1,
      unit_price_gbp: price,
      amount_gbp: o.dry_run ? 0 : price,
      synthetic: false,
    });
    total += o.dry_run ? 0 : price;
  }
  return total;
}

/**
 * Alerts at 50 / 80 / 100% (policy) of a graph run's budget and of today's global daily cap, each once.
 * Live spend only: sandbox, probe and planner spend never count as live.
 */
export async function checkBudgetAlerts(
  d: Pick<GraphRuntimeDeps, "storage" | "cfg" | "policy">,
  runId: string,
  compiled: CompiledGraph,
  now = new Date(),
): Promise<string[]> {
  const raised: string[] = [];
  const seen = new Set((await d.storage.alerts.list({ limit: 1000 })).map((a) => a.message));
  const raise = async (msg: string, data: Record<string, unknown>) => {
    if (seen.has(msg)) return;
    await d.storage.alerts.raise("graph_budget", msg, data);
    seen.add(msg);
    raised.push(msg);
  };
  const run = await d.storage.graphRuns.get(runId);
  for (const t of d.policy.runtime.budget_alert_thresholds)
    if (run && run.cost_so_far_gbp >= t * compiled.spec.budgetGbp)
      await raise(
        `Graph run ${runId.slice(0, 8)} (${compiled.spec.graphId}) has used ${Math.round(t * 100)}% of its £${compiled.spec.budgetGbp.toFixed(2)} budget`,
        { run_id: runId, threshold: t },
      );
  const day = now.toISOString().slice(0, 10);
  const live = (
    await d.storage.costEvents.range({
      from: `${day}T00:00:00.000Z`,
      to: `${day}T23:59:59.999Z`,
      modes: ["live"],
    })
  )
    .filter((e) => !e.synthetic)
    .reduce((a, e) => a + e.amount_gbp, 0);
  const cap = d.cfg.caps.global_per_day_gbp;
  for (const t of d.policy.runtime.budget_alert_thresholds)
    if (cap > 0 && live >= t * cap)
      await raise(
        `Live spend today has reached ${Math.round(t * 100)}% of the £${cap.toFixed(2)} daily cap`,
        { day, threshold: t },
      );
  return raised;
}

/** Infra allocation for one node: its Workflow steps at the published rate. */
async function recordInfra(
  d: GraphRuntimeDeps,
  task: StoredTask,
  runId: string,
  compiled: CompiledGraph,
  node: GraphNode,
) {
  const rates = loadInfraPricesConfig();
  const step = rates.rates.workflow_step as { usd_per_unit: number };
  const qty = d.policy.limits.steps_per_node;
  const unit = step.usd_per_unit * d.models.usd_to_gbp;
  await d.storage.costEvents.add({
    event_id: crypto.randomUUID(),
    at: new Date().toISOString(),
    run_id: runId,
    graph_id: compiled.spec.graphId,
    graph_version: compiled.spec.version,
    node_id: node.id,
    task_id: task.task_id,
    opportunity_id: null,
    revenue_path: task.revenue_path,
    shape_fingerprint: compiled.shapeFingerprint,
    mode: "live",
    category: "infra",
    unit: "workflow_step",
    quantity: qty,
    unit_price_gbp: unit,
    amount_gbp: unit * qty,
    price_table_version: rates.price_table_version,
    synthetic: false,
    dry_run: true,
  });
}

/**
 * Every state value must fit one D1 row (2,000,000 bytes) and one Workflow step result (1 MiB), checked
 * against current Cloudflare docs on 2026-11-18. The policy cap (512 KiB) sits under both. A node that
 * writes more fails here, before anything is stored or passed on.
 */
export function assertStateSize(writes: Record<string, unknown>, maxBytes: number): void {
  for (const [k, v] of Object.entries(writes)) {
    const bytes = new TextEncoder().encode(JSON.stringify(v ?? null)).length;
    if (bytes > maxBytes)
      throw new Error(`state value "${k}" is ${bytes} bytes; the limit is ${maxBytes}`);
  }
}

/**
 * The graph_node job: runs ONE role node with the same step code as the old runner, records its costs,
 * then tells the run it's done. Idempotent: a duplicated job re-sends the stored result.
 */
export async function runGraphNodeJob(
  d: GraphRuntimeDeps,
  job: GraphNodeJob,
  port: WorkflowPort,
  hooks: { crashAfterStep?: (job: GraphNodeJob) => boolean } = {},
): Promise<void> {
  const type = graphEventType("gd", job.run_id, job.node_id, job.iteration);
  const row = await d.storage.graphNodeRuns.start(job.run_id, job.node_id, job.iteration);
  if (row.status === "done") {
    await port.sendEvent(job.instance_id, type, row.recorded_model_output);
    return;
  }
  const compiled = await loadCompiled(d.storage, job.graph_id, job.version);
  const node = compiled.spec.nodes.find((n) => n.id === job.node_id) as GraphNode;
  const task = (await d.storage.tasks.get(job.task_id)) as StoredTask;
  const latest = new Map(
    (await d.storage.graphState.latest(job.run_id)).map((v) => [v.key, v.value]),
  );
  const inputs = Object.fromEntries(node.reads.map((k) => [k, latest.get(k)]));
  const before = (await d.storage.runLog.forTask(task.task_id)).length;
  const out = await legacyBindings({ storage: d.storage, cfg: d.cfg, runner: d.runner }, task).run({
    runId: job.run_id,
    node,
    iteration: job.iteration,
    inputs,
    compiled,
  });
  if (hooks.crashAfterStep?.(job)) throw new Error("injected crash after the step ran");
  if (out.status !== "done") throw new Error(`role node ${node.id} didn't finish`);
  const log = (await d.storage.runLog.forTask(task.task_id)).slice(before);
  let cost = 0;
  for (const entry of log)
    cost += await recordStepCosts(d, {
      entry,
      task,
      run_id: job.run_id,
      graph_id: compiled.spec.graphId,
      graph_version: compiled.spec.version,
      node_id: node.id,
      shape: compiled.shapeFingerprint,
      mode: "live",
      dry_run: true,
    });
  assertStateSize(out.writes, d.policy.runtime.state_value_max_bytes);
  const payload = { writes: out.writes, cost_gbp: cost };
  await d.storage.graphNodeRuns.finish(job.run_id, job.node_id, job.iteration, {
    status: "done",
    cost_gbp: cost,
    recorded_model_output: payload,
  });
  await port.sendEvent(job.instance_id, type, payload);
}

interface GraphTaskState {
  graph_run?: { run_id: string; instance_id: string; graph_id: string; version: number };
  awaiting?: { step_id: string; item: unknown; kind: "gate" | "check_failed" };
  [k: string]: unknown;
}

/** The graph_run workflow definition. */
export function graphRunWorkflow(d: GraphRuntimeDeps): WorkflowDef<GraphRunParams, unknown> {
  return {
    name: GRAPH_WORKFLOW,
    playbook: "graph",
    run: async (p, step: WorkflowStep, wctx) => {
      const compiled = await loadCompiled(d.storage, p.graph_id, p.version);
      const task = (await d.storage.tasks.get(p.task_id)) as StoredTask;
      const entity = task.source_ref.match(/entity:([^:]+)$/)?.[1] ?? "";
      const rs0: RunState = newRunState(p.run_id, compiled, { entity_ref: entity });
      await step.do("init", async () => {
        for (const [k, v] of Object.entries(rs0.values))
          await d.storage.graphState.put({
            run_id: p.run_id,
            key: k,
            iteration: 0,
            value: v,
            untrusted: false,
            lane: compiled.lane,
            written_by: "input",
          });
        await d.storage.graphRuns.update(p.run_id, {
          status: "running",
          instance_id: wctx.instanceId,
        });
        return true;
      });
      let pauses = 0;
      const legacy = legacyBindings({ storage: d.storage, cfg: d.cfg, runner: d.runner }, task);
      const persist = async (
        ctx: NodeContext,
        writes: Record<string, unknown>,
        extraCost: number,
      ) => {
        for (const [k, v] of Object.entries(writes))
          await d.storage.graphState.put({
            run_id: p.run_id,
            key: k,
            iteration: ctx.iteration,
            value: v,
            untrusted: !!compiled.spec.state[k]?.untrusted,
            lane: compiled.lane,
            written_by: ctx.node.id,
          });
        if (extraCost) await d.storage.graphRuns.addCost(p.run_id, extraCost);
        await recordInfra(d, task, p.run_id, compiled, ctx.node);
        await checkBudgetAlerts(d, p.run_id, compiled);
      };

      const bindings: Bindings = {
        beforeNode: async (ctx) => {
          const key = `${ctx.node.id}#${ctx.iteration}`;
          const why = await step.do(`pre:${key}:${pauses}`, () =>
            pauseReason(d, task, compiled, p.run_id, ctx.node),
          );
          if (why) {
            await step.do(`paused:${key}:${pauses}`, async () => {
              await d.storage.graphRuns.update(p.run_id, { status: "paused", pause_reason: why });
              await d.storage.alerts.raise(
                "graph_paused",
                `Graph run ${p.run_id.slice(0, 8)} paused before ${ctx.node.id}: ${why}`,
                { run_id: p.run_id },
              );
              return true;
            });
            throw new GraphPausedError(why);
          }
        },
        run: async (ctx): Promise<NodeOutcome> => {
          const n = ctx.node;
          const key = `${n.id}#${ctx.iteration}`;
          if (n.kind === "role") {
            await step.do(`dispatch:${key}`, async () => {
              await d.dispatch({
                kind: "graph_node",
                run_id: p.run_id,
                task_id: p.task_id,
                graph_id: p.graph_id,
                version: p.version,
                node_id: n.id,
                iteration: ctx.iteration,
                instance_id: wctx.instanceId,
              });
              return true;
            });
            const ev = await step.waitForEvent<{
              writes: Record<string, unknown>;
              cost_gbp: number;
            }>(
              `node:${key}`,
              graphEventType("gd", p.run_id, n.id, ctx.iteration),
              NODE_TIMEOUT_MS(d.policy, n),
            );
            if (!ev) throw new Error(`node ${key} didn't report back in time`);
            await step.do(`post:${key}`, async () => {
              await persist(ctx, ev.writes, ev.cost_gbp);
              return true;
            });
            return { status: "done", writes: ev.writes };
          }
          if (n.kind === "function") {
            const out = await step.do(`${key}`, () => legacy.run(ctx));
            if (out.status === "done")
              await step.do(`post:${key}`, async () => {
                await persist(ctx, out.writes, 0);
                return true;
              });
            return out;
          }
          if (n.kind === "approval") {
            const item = await step.do(`ask:${key}`, async () => {
              const asked = await legacy.run(ctx);
              const it = asked.status === "waiting" ? asked.item : null;
              const kind =
                (n.config as { kind?: string }).kind === "check_failed" ? "check_failed" : "gate";
              const fresh = (await d.storage.tasks.get(task.task_id)) as StoredTask;
              await d.storage.tasks.update(task.task_id, {
                status: "awaiting_approval",
                state: {
                  ...(fresh.state as GraphTaskState),
                  awaiting: {
                    step_id: kind === "check_failed" ? n.id.replace(/_review$/, "") : n.id,
                    item: it,
                    kind,
                  },
                  graph_waiting: { node_id: n.id, iteration: ctx.iteration },
                },
              });
              await d.storage.graphRuns.update(p.run_id, { status: "waiting" });
              return it;
            });
            const ev = await step.waitForEvent<{
              decision: "approve" | "edit" | "reject";
              edited_text?: string | null;
            }>(
              `approval:${key}`,
              graphEventType("ga", p.run_id, n.id, ctx.iteration),
              d.policy.runtime.approval_timeout_days * 86_400_000,
            );
            const outcome = await step.do(`decided:${key}`, async (): Promise<NodeOutcome> => {
              await d.storage.graphRuns.update(p.run_id, { status: "running" });
              const fresh = (await d.storage.tasks.get(task.task_id)) as StoredTask;
              const st = { ...(fresh.state as GraphTaskState) };
              delete st.awaiting;
              delete st.graph_waiting;
              await d.storage.tasks.update(task.task_id, { status: "running", state: st });
              if (!ev)
                return { status: "rejected", reason: "defaulted: no decision before the deadline" };
              return approvalOutcome(
                d,
                task,
                compiled,
                n,
                ctx.inputs,
                item,
                ev.decision,
                ev.edited_text ?? null,
              );
            });
            if (outcome.status === "done")
              await step.do(`post:${key}`, async () => {
                await persist(ctx, outcome.writes, 0);
                return true;
              });
            return outcome;
          }
          throw new Error(`${n.kind} nodes aren't run by the G2 runtime yet`);
        },
      };

      let rs = rs0;
      for (;;) {
        rs = await runGraph(compiled, bindings, rs);
        if (rs.status !== "paused") break;
        pauses++;
        await step.sleep(`paused #${pauses}`, 5 * 60_000);
        rs.status = "running";
        await step.do(`resumed #${pauses}`, async () => {
          await d.storage.graphRuns.update(p.run_id, { status: "running", pause_reason: null });
          return true;
        });
      }
      return step.do("finish", async () => {
        // done → task done; rejected (by Archie, or defaulted) or stopped (outreach not allowed) → cancelled.
        const ended = new Date().toISOString();
        await d.storage.graphRuns.update(p.run_id, {
          status: rs.status === "done" ? "done" : "failed",
          ended_at: ended,
        });
        const reason =
          rs.status === "stopped" ? `stopped at ${rs.stoppedAt}: outreach not allowed` : null;
        await d.storage.tasks.update(task.task_id, {
          status: rs.status === "done" ? "done" : "cancelled",
          ...(reason ? { error: reason } : {}),
        });
        return { status: rs.status };
      });
    },
  };
}

/** Archie's decision at an approval node: the same records as PlaybookRunner.decide. */
async function approvalOutcome(
  d: GraphRuntimeDeps,
  task: StoredTask,
  compiled: CompiledGraph,
  node: GraphNode,
  inputs: Record<string, unknown>,
  item: unknown,
  decision: "approve" | "edit" | "reject",
  editedText: string | null,
): Promise<NodeOutcome> {
  const cfg = node.config as { playbook: string; kind?: string };
  await d.storage.approvals.add({
    task_id: task.task_id,
    step_id: cfg.kind === "check_failed" ? node.id.replace(/_review$/, "") : node.id,
    item_shown: item,
    decision,
    edited_text: decision === "edit" ? editedText : null,
    graph_id: compiled.spec.graphId,
    graph_version: compiled.spec.version,
    node_id: node.id,
  });
  if (decision === "reject") return { status: "rejected" };
  const writes: Record<string, unknown> = { approved: true };
  if (decision === "edit" && editedText) {
    const before = d.runner.gateForGraph(cfg.playbook, inputs);
    const after = d.runner.gateForGraph(cfg.playbook, inputs, editedText);
    for (const k of node.writes)
      if (k !== "approved" && k in after.outputs) writes[k] = after.outputs[k];
    await d.storage.examples.add({
      playbook: task.playbook,
      step_id: "draft",
      task_id: task.task_id,
      original: JSON.stringify(before.item),
      edited: editedText,
    });
  }
  return { status: "done", writes };
}

/** Archie's decision on a graph-run task reaches its workflow as an event. */
export async function sendGraphDecision(
  storage: Storage,
  port: WorkflowPort,
  task: StoredTask,
  decision: "approve" | "edit" | "reject",
  editedText: string | null,
): Promise<boolean> {
  const st = task.state as GraphTaskState & {
    graph_waiting?: { node_id: string; iteration: number };
  };
  if (!st.graph_run || !st.graph_waiting) return false;
  await port.sendEvent(
    st.graph_run.instance_id,
    graphEventType("ga", st.graph_run.run_id, st.graph_waiting.node_id, st.graph_waiting.iteration),
    {
      decision,
      edited_text: editedText,
    },
  );
  void storage;
  return true;
}
