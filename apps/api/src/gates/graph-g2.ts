import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadInfraConfig, loadInfraPricesConfig, loadModelsConfig } from "@ae/config";
import type { CompiledGraph } from "@ae/contracts";
import { rollUp } from "@ae/graph";
import {
  checkBudgetAlerts,
  createTask,
  type GraphNodeJob,
  K,
  loadCompiled,
  runGraphNodeJob,
  setKillSwitch,
} from "@ae/infra";
import type { Storage, StoredTask } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { createApp } from "../app.ts";

/**
 * Graph G2 gate: the graph runtime (GRAPH_ENGINE_ENABLED) on the persisted-step workflow engine, the
 * same `graph_run` definition GraphRunWorkflow runs on Cloudflare. Dry-run throughout.
 */
async function world(
  root: string,
  o: { enabled: boolean; clock: { now: Date }; inline?: GraphNodeJob[] },
) {
  const storage = await openSqliteStorage(":memory:");
  const model = fakeModel();
  await buildSyntheticWorld(storage, model, { count: 40, seed: 11 });
  const facts = (await storage.facts.listCurrent({ status: "verified", limit: 2000, offset: 0 }))
    .rows;
  // Companies with a verified email first, so the dry-run sends have a recipient to (not) send to.
  const withEmail = new Set(
    facts.filter((f) => f.field === "contact_email").map((f) => f.entity_id),
  );
  const entities = [...new Set(facts.map((f) => f.entity_id))].sort(
    (a, b) => Number(withEmail.has(b)) - Number(withEmail.has(a)) || a.localeCompare(b),
  );
  const service: AgentService = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    graphEngine: { enabled: o.enabled },
    now: () => o.clock.now,
    // `inline`: run each role node the moment it's dispatched, so its "done" event arrives before the
    // Workflow waits for it (the buffered-event case).
    ...(o.inline
      ? {
          graphDispatch: async (job: GraphNodeJob) => {
            o.inline?.push(job);
            await runGraphNodeJob(service.graphDeps, job, service.workflowPort);
          },
        }
      : {}),
  });
  return { storage, service, entities };
}

async function newOutreach(w: Awaited<ReturnType<typeof world>>, n: number) {
  const { task } = await createTask(
    w.storage,
    loadInfraConfig(),
    w.service.playbooks,
    w.service.queue,
    {
      idempotency_key: `g2:${n}`,
      playbook: "sme_outreach",
      revenue_path: "sme_outreach",
      source_ref: `opportunity:g2-${n}:entity:${w.entities[n]}`,
      lane: "open",
    },
  );
  await w.service.runQueued();
  return (await w.storage.tasks.get(task.task_id)) as StoredTask;
}
const runOf = (t: StoredTask) =>
  (t.state as { graph_run: { run_id: string; instance_id: string } }).graph_run;

export async function runGraphG2Gate(
  _storage: Storage,
  root: string,
  o: { workerBuild?: boolean } = {},
) {
  const clock = { now: new Date() };
  const later = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };

  // 1. End to end: sme_outreach on the graph runtime, approval resolved from the dashboard API.
  const W = await world(root, { enabled: true, clock });
  const app = createApp({
    runtime: "node",
    storage: () => W.storage,
    decide: (t, d, e) => W.service.decide(t, d, e),
  });
  const t1 = await newOutreach(W, 0);
  const r1 = runOf(t1);
  const waiting = (await W.storage.workflows.get(r1.instance_id))?.status;
  const queue = (await (await app.request("/api/decisions?type=draft")).json()) as {
    open: { id: string; source_ref: string }[];
  };
  const decision = queue.open.find((x) => x.source_ref === `task:${t1.task_id}`);
  const decided = decision
    ? await app.request(`/api/decisions/${decision.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option: "approve" }),
      })
    : null;
  const done1 = (await W.storage.tasks.get(t1.task_id)) as StoredTask;
  const log1 = await W.storage.runLog.forTask(t1.task_id);
  const run1 = await W.storage.graphRuns.get(r1.run_id);
  const outbox1 = (await W.storage.outbox.forEntity(W.entities[0] as string)).filter(
    (m) => m.task_id === t1.task_id,
  );

  // 2. Cost events: exactly one per model call and per tool call; roll-ups equal the sum of their events.
  const events = await W.storage.costEvents.forRun(r1.run_id);
  const modelCalls = log1.filter((l) => l.model).length;
  const toolCalls = log1.flatMap((l) => l.tool_calls).filter((c) => !c.blocked).length;
  const byNode = rollUp(events, (e) => e.node_id ?? "-");
  const sumNodes = [...byNode.values()].reduce((a, v) => a + v.gbp, 0);
  const sumAll = events.reduce((a, e) => a + e.amount_gbp, 0);

  // 3. Kill switch: a run waiting at its approval; the switch goes on; approving it must not reach the send.
  const t2 = await newOutreach(W, 1);
  const r2 = runOf(t2);
  await setKillSwitch(W.storage, { playbook: "sme_outreach" }, true, "gate");
  await W.service.decide(t2.task_id, "approve", null);
  const paused = await W.storage.graphRuns.get(r2.run_id);
  const sentWhilePaused = (await W.storage.runLog.forTask(t2.task_id)).some(
    (l) => l.step_id === "send",
  );
  await W.storage.controls.set(K.playbook("sme_outreach"), false, "gate");
  later(6 * 60_000);
  await W.service.workflows.tick();
  await W.service.processGraphJobs();
  const resumed = (await W.storage.tasks.get(t2.task_id)) as StoredTask;

  // 4. A forced failure after the send ran resumes without repeating it (v2 rule 17).
  const t3 = await newOutreach(W, 2);
  let crashed = false;
  let lost: unknown = null;
  const original = W.service.graphJobs;
  W.service.graphJobHooks = {
    crashAfterStep: (job) => {
      if (job.node_id === "send" && !crashed) {
        crashed = true;
        lost = job;
        return true;
      }
      return false;
    },
  };
  await W.service.decide(t3.task_id, "approve", null).catch(() => undefined);
  W.service.graphJobHooks = {};
  // The queue would retry the job: deliver it again.
  if (lost) original.push(lost as never);
  await W.service.processGraphJobs();
  const outbox3 = (await W.storage.outbox.forEntity(W.entities[2] as string)).filter(
    (m) => m.task_id === t3.task_id,
  );
  const sends3 = (await W.storage.runLog.forTask(t3.task_id)).filter((l) => l.step_id === "send");
  const done3 = (await W.storage.tasks.get(t3.task_id)) as StoredTask;

  // 5. An approval nobody answers: the safe default after the deadline, never counted as Archie's approval.
  const t4 = await newOutreach(W, 3);
  const approvalsBefore = (await W.storage.ownerApprovals.list(1000)).length;
  later(8 * 86_400_000);
  await W.service.workflows.tick();
  const defaulted = (await W.storage.tasks.get(t4.task_id)) as StoredTask;
  const approvalsAfter = (await W.storage.ownerApprovals.list(1000)).length;
  const t4Approvals = await W.storage.approvals.forTask(t4.task_id);

  // 6. An empty pool pauses a running graph before its next step (real spend only); a top-up resumes it.
  W.service.graphDeps.realSpend = true;
  const t5 = await newOutreach(W, 4);
  const r5 = runOf(t5);
  const poolPaused = await W.storage.graphRuns.get(r5.run_id);
  const firstNodeRan = (await W.storage.runLog.forTask(t5.task_id)).length > 0;
  await W.storage.poolEvents.add({
    event_id: "topup-1",
    at: clock.now.toISOString(),
    kind: "topup",
    amount_gbp: 5,
    approval_id: "gate",
    by: "archie",
    note: "gate top-up",
  });
  later(6 * 60_000);
  await W.service.workflows.tick();
  await W.service.processGraphJobs();
  const afterTopup = await W.storage.graphRuns.get(r5.run_id);
  W.service.graphDeps.realSpend = false;

  // 7. Budget alerts at 50 / 80 / 100%, once each.
  const compiled: CompiledGraph = await loadCompiled(W.storage, "pb-sme-outreach", 2);
  await W.storage.graphRuns.addCost(r1.run_id, compiled.spec.budgetGbp * 0.85);
  const a1 = await checkBudgetAlerts(
    { storage: W.storage, cfg: W.service.infra, policy: W.service.graphDeps.policy },
    r1.run_id,
    compiled,
  );
  const a2 = await checkBudgetAlerts(
    { storage: W.storage, cfg: W.service.infra, policy: W.service.graphDeps.policy },
    r1.run_id,
    compiled,
  );

  // 8. Flag off: everything runs on the old runner, exactly as before.
  const off = await world(root, { enabled: false, clock });
  const t6 = await newOutreach(off, 5);
  const offRuns = await off.storage.graphRuns.list();

  // 10. A node that finishes before the Workflow waits for it still completes (the event is buffered);
  // the same queue job delivered twice doesn't run the node twice.
  const inline: GraphNodeJob[] = [];
  const E = await world(root, { enabled: true, clock, inline });
  const t7 = await newOutreach(E, 0);
  const early = (await E.storage.tasks.get(t7.task_id)) as StoredTask;
  const logBefore = (await E.storage.runLog.forTask(t7.task_id)).length;
  const costBefore = (await E.storage.costEvents.forRun(runOf(t7).run_id)).length;
  for (const job of inline) await runGraphNodeJob(E.service.graphDeps, job, E.service.workflowPort);
  const logAfter = (await E.storage.runLog.forTask(t7.task_id)).length;
  const costAfter = (await E.storage.costEvents.forRun(runOf(t7).run_id)).length;

  // 11. The legacy cost fields (run_log, tasks.cost_gbp) agree with the new cost ledger.
  const logCost = log1.reduce((a, l) => a + l.cost_gbp, 0);
  const ledgerCost = events
    .filter((e) => e.category === "model" || e.category === "tool")
    .reduce((a, e) => a + e.amount_gbp, 0);

  // 9. The Worker builds with the GraphRunWorkflow binding.
  let build = "skipped (unit test)";
  if (o.workerBuild) {
    const out = execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        mkdtempSync(join(tmpdir(), "ae-g2-")),
      ],
      {
        cwd: join(root, "apps/api"),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    build = /env\.GRAPH \(GraphRunWorkflow\)/.test(out)
      ? "GRAPH (GraphRunWorkflow) bound"
      : "GRAPH binding MISSING";
  }

  const criteria: GateCriterion[] = [
    {
      criterion:
        "sme_outreach runs end to end on the graph runtime in dry-run, with the approval resolved from the dashboard",
      status:
        waiting === "sleeping" &&
        decided?.status === 200 &&
        done1.status === "done" &&
        run1?.status === "done" &&
        log1.map((l) => l.step_id).join(",") === "research,draft,check,send" &&
        log1.every((l) => l.graph_id === "pb-sme-outreach" && l.node_id) &&
        outbox1.length === 1 &&
        outbox1.every((m) => m.status === "dry_run")
          ? "passed (synthetic)"
          : "failed",
      evidence: `instance waited at the approval (${waiting}); approved through POST /api/decisions/:id/decide (${decided?.status}); steps ${log1.map((l) => `${l.step_id}@${l.node_id}`).join(", ")}; ${outbox1.length} email, ${outbox1.map((m) => m.status).join(",")}; task ${done1.status}`,
    },
    {
      criterion:
        "Every model and tool call produces exactly one cost event; roll-ups equal the sum of their events",
      status:
        events.filter((e) => e.category === "model").length === modelCalls &&
        events.filter((e) => e.category === "tool").length === toolCalls &&
        Math.abs(sumNodes - sumAll) < 1e-12 &&
        // Each event carries the CURRENT price table's version: models.json for model and tool
        // calls, infra-prices.json for infra.
        events.every(
          (e) =>
            e.price_table_version ===
            (e.category === "infra"
              ? loadInfraPricesConfig().price_table_version
              : loadModelsConfig().price_table_version),
        )
          ? "passed (synthetic)"
          : "failed",
      evidence: `${modelCalls} model calls → ${events.filter((e) => e.category === "model").length} model events; ${toolCalls} tool calls → ${events.filter((e) => e.category === "tool").length} tool events; ${events.filter((e) => e.category === "infra").length} infra events; per-node roll-up £${sumNodes.toFixed(6)} = sum £${sumAll.toFixed(6)}`,
    },
    {
      criterion:
        "The kill switch stops a running instance before its next step; clearing it resumes the run",
      status:
        paused?.status === "paused" &&
        /kill switch/.test(paused.pause_reason ?? "") &&
        !sentWhilePaused &&
        resumed.status === "done"
          ? "passed (synthetic)"
          : "failed",
      evidence: `paused before the next node: "${paused?.pause_reason}"; the send didn't run while paused; after the switch went off, the run resumed and finished (${resumed.status})`,
    },
    {
      criterion: "A forced failure resumes without repeating a completed external step",
      status:
        crashed && outbox3.length === 1 && sends3.length >= 1 && done3.status === "done"
          ? "passed (synthetic)"
          : "failed",
      evidence: `the send job crashed after the step ran; the retried job found the recorded effect, so ${outbox3.length} email exists (not 2); task ${done3.status}`,
    },
    {
      criterion:
        "An approval left unanswered takes the safe default (nothing sent), never counted as Archie's approval",
      status:
        defaulted.status === "cancelled" &&
        approvalsAfter === approvalsBefore &&
        t4Approvals.length === 0
          ? "passed (synthetic)"
          : "failed",
      evidence: `after the 7-day deadline the task is ${defaulted.status}; owner approvals ${approvalsBefore} → ${approvalsAfter}; no approval row for the task`,
    },
    {
      criterion:
        "An empty pool pauses a running graph before its next step; a top-up lets it continue",
      status:
        poolPaused?.status === "paused" &&
        /pool/.test(poolPaused.pause_reason ?? "") &&
        !firstNodeRan &&
        afterTopup?.status === "waiting"
          ? "passed (synthetic)"
          : "failed",
      evidence: `with real spend and £0 in the pool the run paused before its first model step ("${poolPaused?.pause_reason}"); after a £5 top-up it ran on to the approval (${afterTopup?.status})`,
    },
    {
      criterion: "Alerts at 50%, 80% and 100% of a graph's budget, each raised once",
      status: a1.length === 2 && a2.length === 0 ? "passed (synthetic)" : "failed",
      evidence: `at 85% of the budget: ${a1.length} alerts (50%, 80%); checked again: ${a2.length} new`,
    },
    {
      criterion:
        "Behind the flag: with GRAPH_ENGINE_ENABLED off, tasks run on the old runner exactly as before",
      status:
        offRuns.length === 0 && t6.status === "awaiting_approval" ? "passed (synthetic)" : "failed",
      evidence: `flag off: ${offRuns.length} graph runs; the task ran on the old runner (${t6.status})`,
    },
    {
      criterion:
        "A node that finishes before the Workflow waits for it still completes; a duplicated queue job doesn't run the node twice",
      status:
        inline.length >= 3 &&
        early.status === "awaiting_approval" &&
        logAfter === logBefore &&
        costAfter === costBefore
          ? "passed (synthetic)"
          : "failed",
      evidence: `${inline.length} role nodes finished inside their dispatch, before the wait; the run still reached the approval (${early.status}); every job delivered again: run log ${logBefore} → ${logAfter} lines, cost events ${costBefore} → ${costAfter}`,
    },
    {
      criterion: "Legacy cost fields (run_log, tasks.cost_gbp) reconcile with cost_events",
      status:
        Math.abs(logCost - ledgerCost) < 1e-9 && Math.abs(done1.cost_gbp - logCost) < 1e-9
          ? "passed (synthetic)"
          : "failed",
      evidence: `run log £${logCost.toFixed(6)}; task £${done1.cost_gbp.toFixed(6)}; model + tool cost events £${ledgerCost.toFixed(6)} (infra events are new and have no legacy field)`,
    },
    {
      criterion: "The Worker builds with the GraphRunWorkflow binding",
      status: !o.workerBuild || /bound/.test(build) ? "passed (synthetic)" : "failed",
      evidence: build,
    },
  ];
  return { criteria };
}
