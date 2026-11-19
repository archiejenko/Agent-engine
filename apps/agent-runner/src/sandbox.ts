import { loadGraphPolicy, loadInfraConfig } from "@ae/config";
import { type CompiledGraph, SANDBOX_NOTE, SandboxReport } from "@ae/contracts";
import { rollUp } from "@ae/graph";
import { createTask, K, type LoadedPlaybook } from "@ae/infra";
import type { FakeModel, ModelClient } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { buildSyntheticWorld } from "./gates/synthetic-world.ts";
import { AgentService, fakeModel } from "./service.ts";

/**
 * The sandbox (graph plan G3): runs a converted graph end to end on the graph runtime against a fresh,
 * synthetic world, with fakes for every port and every external tool forced dry. It measures mechanics
 * and cost per node. It cannot measure demand: nobody real reads anything it produces.
 */

export interface SandboxScenario {
  name: string;
  /** A failure scenario (the plan asks for at least one per graph). */
  failure: boolean;
  /** Archie's answers, in order, at each approval the run reaches. */
  decisions: ("approve" | "edit" | "reject")[];
  /** A registered tool that throws whenever it's called (the "tool error" scenario). */
  toolError?: string;
  /** The playbook's kill switch is on before the run starts (it must pause before its first node). */
  killSwitch?: boolean;
  /** What a pass means for this scenario: the task's final status. */
  expect: StoredTask["status"][];
}

export const KILL_SWITCH_ON: SandboxScenario = {
  name: "kill switch on",
  failure: true,
  decisions: [],
  killSwitch: true,
  expect: ["queued", "in_progress", "running", "awaiting_approval"] as StoredTask["status"][],
};

export const HAPPY_PATH: SandboxScenario = {
  name: "happy path",
  failure: false,
  decisions: ["approve", "approve"],
  expect: ["done"],
};

/**
 * The failure scenarios for one playbook, from what its happy path did: "Archie rejects" where it asks
 * for an approval, and "tool error" on the first tool it actually called.
 */
export function failureScenarios(happy: { askedApproval: boolean; toolsCalled: string[] }) {
  const out: SandboxScenario[] = [];
  if (happy.askedApproval)
    out.push({
      name: "Archie rejects",
      failure: true,
      decisions: ["reject"],
      expect: ["cancelled"],
    });
  const tool = happy.toolsCalled[0];
  if (tool)
    out.push({
      name: `tool error (${tool} down)`,
      failure: true,
      decisions: ["approve", "approve"],
      toolError: tool,
      expect: ["failed"],
    });
  out.push(KILL_SWITCH_ON);
  return out;
}

/** A fresh synthetic world: companies with facts (emails first), one monitoring customer and watch. */
export async function sandboxWorld(storage: Storage, model: FakeModel = fakeModel()) {
  await buildSyntheticWorld(storage, model, { count: 40, seed: 11 });
  const facts = (await storage.facts.listCurrent({ status: "verified", limit: 2000, offset: 0 }))
    .rows;
  const withEmail = new Set(
    facts.filter((f) => f.field === "contact_email").map((f) => f.entity_id),
  );
  const entities = [...new Set(facts.map((f) => f.entity_id))].sort(
    (a, b) => Number(withEmail.has(b)) - Number(withEmail.has(a)) || a.localeCompare(b),
  );
  const customer = await storage.customers.add({
    id: "cust-sandbox",
    name: "Sandbox Ltd",
    email: "alerts@example.invalid",
    plan: "per_alert",
    payment_ref: null,
  });
  const entity = entities[0] as string;
  const watchId = await storage.watches.add({
    customer_id: customer,
    entity_id: entity,
    fields: ["company_status"],
    channel: "email",
    target: "alerts@example.invalid",
  });
  return { entities, entity, watchId };
}

/** How each converted playbook's task is created in the sandbox (the same shapes as G1's fixtures). */
export function sandboxFixture(
  playbook: string,
  w: Awaited<ReturnType<typeof sandboxWorld>>,
): { source_ref: string; state?: Record<string, unknown> } {
  const e = w.entity;
  switch (playbook) {
    case "post_reply":
      return {
        source_ref: `reply:msg-sandbox:entity:${e}`,
        state: {
          reply: {
            from: "owner@example.invalid",
            subject: "Re: your idea",
            body: "Sounds interesting, what would it cost?",
            received_at: "2026-11-18T09:00:00Z",
          },
        },
      };
    case "human_report":
      return {
        source_ref: `stripe:cs_test_sandbox:entity:${e}`,
        state: { company_number: e, email: "buyer@example.invalid" },
      };
    case "monitoring_subscription":
      return { source_ref: "stripe:cs_test_sandbox_mon" };
    case "watch_alert":
      return {
        source_ref: `watch:${w.watchId}:entity:${e}`,
        state: {
          change: {
            watch_id: w.watchId,
            field: "company_status",
            old_value: "active",
            new_value: "liquidation",
            version: 2,
            watch: {
              id: w.watchId,
              customer_id: "cust-sandbox",
              entity_id: e,
              fields: ["company_status"],
              channel: "email",
              target: "alerts@example.invalid",
              active: true,
            },
          },
        },
      };
    default:
      return { source_ref: `opportunity:sandbox:entity:${e}` };
  }
}

export interface SandboxRunResult {
  report: SandboxReport;
  task: StoredTask;
  /** External tool calls the run made, and whether each one was dry. */
  effects: { tool: string; dry_run: boolean }[];
  costModes: string[];
  toolsCalled: string[];
  askedApproval: boolean;
}

/**
 * Runs one playbook's graph through one scenario in a fresh sandbox. `storage` must be a new, empty
 * database (the caller makes it; it is never the production database).
 */
export async function runSandbox(o: {
  storage: Storage;
  playbooks: Map<string, LoadedPlaybook>;
  playbook: string;
  scenario: SandboxScenario;
  model?: ModelClient;
  /** A compiled graph to run instead of the playbook's own (a planner attempt, or a probe). */
  compiled?: CompiledGraph;
  /** "probe": a planner probe (read-only, ≤ 5 nodes); reported and stored as a probe. */
  mode?: "sandbox" | "probe";
  attempt?: number;
  expectedValueGbp?: number | null;
  now?: () => Date;
}): Promise<SandboxRunResult> {
  const policy = loadGraphPolicy();
  const model = o.model ?? fakeModel();
  const w = await sandboxWorld(o.storage, fakeModel());
  const service = new AgentService({
    storage: o.storage,
    playbooks: o.playbooks,
    model,
    sandbox: true,
    graphEngine: { enabled: true, playbooks: [o.playbook] },
    ...(o.now ? { now: o.now } : {}),
  });
  if (o.scenario.toolError) {
    const reg = service.tools.get(o.scenario.toolError);
    if (!reg) throw new Error(`no tool ${o.scenario.toolError}`);
    service.tools.register(reg, async () => {
      throw new Error(`sandbox: ${o.scenario.toolError} is down`);
    });
  }
  const fx = sandboxFixture(o.playbook, w);
  const pb = o.playbooks.get(o.playbook);
  if (!pb) throw new Error(`no playbook ${o.playbook}`);
  const { task } = await createTask(o.storage, loadInfraConfig(), o.playbooks, service.queue, {
    idempotency_key: `sandbox:${o.playbook}:${o.scenario.name}:${o.compiled?.contentHash ?? "playbook"}`,
    playbook: o.playbook,
    revenue_path: pb.spec.revenue_path as never,
    source_ref: fx.source_ref,
    lane: "open",
    // Sandbox rows are synthetic: never learned from, never counted as real work (rule 10).
    synthetic: true,
    ...(fx.state ? { state: fx.state } : {}),
  });
  const failures: string[] = [];
  if (o.scenario.killSwitch) await o.storage.controls.set(K.playbook(o.playbook), true, "sandbox");
  try {
    if (o.compiled) {
      // A planner graph: start it directly (the task is only its carrier), not the playbook's graph.
      const t = (await o.storage.tasks.get(task.task_id)) as StoredTask;
      await o.storage.tasks.update(t.task_id, { status: "running" });
      await service.startCompiledRun(t, o.compiled);
    } else await service.runQueued();
  } catch (e) {
    failures.push(`run: ${(e as Error).message}`);
  }
  let askedApproval = false;
  for (const dec of o.scenario.decisions) {
    const t = (await o.storage.tasks.get(task.task_id)) as StoredTask;
    if (t.status !== "awaiting_approval") break;
    askedApproval = true;
    try {
      await service.decide(task.task_id, dec, dec === "edit" ? "Edited in the sandbox." : null);
    } catch (e) {
      failures.push(`decide: ${(e as Error).message}`);
    }
  }
  const final = (await o.storage.tasks.get(task.task_id)) as StoredTask;
  const graphRun = (
    final.state as { graph_run?: { run_id: string; graph_id: string; version: number } }
  ).graph_run;
  if (!graphRun) throw new Error(`${o.playbook} didn't run as a graph in the sandbox`);
  const nodeRuns = await o.storage.graphNodeRuns.forRun(graphRun.run_id);
  const costs = await o.storage.costEvents.forRun(graphRun.run_id);
  const byNode = rollUp(costs, (e) => e.node_id ?? "-");
  const nodeIds = [...new Set([...nodeRuns.map((n) => n.node_id), ...byNode.keys()])].filter(
    (n) => n !== "-",
  );
  const nodes = nodeIds.map((id) => {
    const runs = nodeRuns.filter((n) => n.node_id === id);
    const last = runs.at(-1);
    const ms =
      last?.started_at && last.ended_at
        ? Math.max(0, Date.parse(last.ended_at) - Date.parse(last.started_at))
        : 0;
    return {
      nodeId: id,
      iteration: last?.iteration ?? 0,
      status: (last?.status ?? "done") as SandboxReport["nodes"][number]["status"],
      costGbp: byNode.get(id)?.gbp ?? 0,
      durationMs: ms,
      checks: [],
      outputRefs: [],
    };
  });
  const effects = (await o.storage.effects.forTask(task.task_id)).map((e) => ({
    tool: e.tool,
    dry_run: e.dry_run,
  }));
  // Spend: what this run cost in the sandbox, and what the same calls would cost live. With the fake
  // model the model lines are zero-cost by construction, so the projection prices them from the
  // reported tokens at the current price table (the cost events carry both).
  const sandboxCost = costs.reduce((a, e) => a + (e.synthetic ? 0 : e.amount_gbp), 0);
  const projected = costs.reduce(
    (a, e) => a + (e.synthetic ? e.quantity * e.unit_price_gbp : e.amount_gbp),
    0,
  );
  if (o.scenario.killSwitch) {
    const run = await o.storage.graphRuns.get(graphRun.run_id);
    if (run?.status !== "paused") failures.push(`run ${run?.status}, expected paused`);
    if (nodeRuns.length > 0) failures.push(`${nodeRuns.length} nodes ran with the kill switch on`);
  }
  if (!o.scenario.expect.includes(final.status))
    failures.push(`ended ${final.status}, expected ${o.scenario.expect.join(" or ")}`);
  if (effects.some((e) => !e.dry_run)) failures.push("an external tool ran live");
  if (sandboxCost > policy.sandbox.max_cost_per_attempt_gbp + 1e-9)
    failures.push(`over the sandbox cap: £${sandboxCost.toFixed(4)}`);
  const report = SandboxReport.parse({
    graphId: graphRun.graph_id,
    version: graphRun.version,
    attempt: o.attempt ?? 1,
    asOf: (o.now?.() ?? new Date()).toISOString(),
    scenario: o.scenario.name,
    mode: o.mode ?? "sandbox",
    model: model.name === "fake-model" ? "fake" : "real",
    pass: failures.length === 0,
    nodes,
    totals: {
      sandboxCostGbp: sandboxCost,
      projectedLiveCostGbp: projected,
      expectedValueGbp: o.expectedValueGbp ?? null,
    },
    failures,
    guardrailHits: [],
    runId: graphRun.run_id,
    note: SANDBOX_NOTE,
  });
  await o.storage.sandboxReports.add({
    id: crypto.randomUUID(),
    graph_id: report.graphId,
    version: report.version,
    attempt: report.attempt,
    scenario: report.scenario,
    mode: o.mode ?? "sandbox",
    as_of: report.asOf,
    pass: report.pass,
    report,
    sandbox_cost_gbp: sandboxCost,
    projected_live_cost_gbp: projected,
    run_id: report.runId,
  });
  const log = await o.storage.runLog.forTask(task.task_id);
  return {
    report,
    task: final,
    effects,
    costModes: [...new Set(costs.map((c) => c.mode))],
    toolsCalled: [...new Set(log.flatMap((l) => l.tool_calls.map((c) => c.tool)))],
    askedApproval: (await o.storage.approvals.forTask(task.task_id)).length > 0 || askedApproval,
  };
}
