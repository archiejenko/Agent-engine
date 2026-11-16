import { join } from "node:path";
import { AgentService, fakeModel, type GateCriterion, loadPlaybooks } from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import {
  BudgetBook,
  createTask,
  K,
  LocalBudgetPort,
  MapKv,
  promotePlaybook,
  reserveForStep,
  setSpendTier,
  settleStep,
  spendTier,
} from "@ae/infra";
import { InMemoryQueue } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { createApp } from "../app.ts";

/**
 * v2 Phase 3 gate: hard budgets. The budget ledger is the same code the Budget Durable Object runs
 * (BudgetBook over a synchronous key-value store); here it sits behind an in-process lock, which gives
 * the same one-call-at-a-time guarantee the Durable Object gives in production.
 */
export async function runV2Phase3Gate(storage: Storage, root: string) {
  const cfg = loadInfraConfig();
  const playbooks = await loadPlaybooks(join(root, "playbooks"));
  const app = createApp({ runtime: "node", storage: () => storage });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const task = async (
    key: string,
    playbook = "sme_outreach",
    state: Record<string, unknown> = {},
  ) =>
    (
      await createTask(storage, cfg, playbooks, new InMemoryQueue(), {
        idempotency_key: key,
        playbook,
        revenue_path: "sme_outreach",
        source_ref: `gate:${key}:entity:00000000`,
        lane: "open",
        state,
        synthetic: true,
      })
    ).task as StoredTask;

  // ---- 1. 50 parallel reservations can't exceed a cap (playbook daily cap £5, £0.25 each → 20 fit).
  const port = new LocalBudgetPort(new BudgetBook(new MapKv()));
  const now = new Date();
  const tasks = await Promise.all(Array.from({ length: 50 }, (_, i) => task(`par-${i}`)));
  const cap = cfg.caps.per_playbook_per_day_gbp.sme_outreach ?? 5;
  const each = 0.25;
  const results = await Promise.allSettled(
    tasks.map((t) => reserveForStep(storage, cfg, port, t, each, now)),
  );
  const granted = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.length - granted;
  const queuePausedAfter = (await storage.controls.get<boolean>(K.queuePaused)) ?? false;
  await storage.controls.set(K.queuePaused, false, "gate");
  // Settle the granted ones at a real (smaller) cost; the freed headroom becomes usable again.
  const ids = results.flatMap((r, i) =>
    r.status === "fulfilled" ? [[r.value, tasks[i]] as const] : [],
  );
  for (const [id, t] of ids) await settleStep(storage, port, id, t as StoredTask, each, 0.1);
  const afterSettle = await reserveForStep(
    storage,
    cfg,
    port,
    tasks[49] as StoredTask,
    each,
    now,
  ).then(
    () => true,
    () => false,
  );

  // Raw book: 50 parallel 1p reservations against a 25p cap.
  const raw = new LocalBudgetPort(new BudgetBook(new MapKv()));
  const rawRes = await Promise.all(
    Array.from({ length: 50 }, (_, i) => raw.reserve(`r${i}`, 0.01, [{ key: "cap", cap: 0.25 }])),
  );
  const rawOk = rawRes.filter((r) => r.ok).length;

  // ---- 2. Spend tiers: raising needs Archie's recorded approval; lowering doesn't.
  const noApproval = await setSpendTier(storage, "sme_letter", "S2", { by: "agent" }).then(
    () => "raised",
    (e: Error) => e.message,
  );
  const forged = await setSpendTier(storage, "sme_letter", "S2", {
    approvalId: "made-up-id",
    by: "agent",
  }).then(
    () => "raised",
    (e: Error) => e.message,
  );
  const viaDashboard = await post("/api/owner-approvals", {
    kind: "spend_tier",
    playbook: "sme_letter",
    tier: "S2",
    note: "gate",
  });
  const approval = (await viaDashboard.json()) as { approval_id: string };
  const tierAfter = await spendTier(storage, "sme_letter");
  const reuse = await setSpendTier(storage, "sme_letter", "S3", {
    approvalId: approval.approval_id,
    by: "agent",
  }).then(
    () => "raised",
    (e: Error) => e.message,
  );
  const lowered = await post("/api/playbooks/sme_letter/spend-tier", { tier: "S0" });
  const tierLowered = await spendTier(storage, "sme_letter");

  // L3 autonomy also needs a recorded approval (promotion criteria relaxed here to reach the check).
  const relaxed = {
    ...cfg,
    autonomy: { ...cfg.autonomy, min_tasks: 0, min_success: 0, min_no_edit: 0, max_breaches: 1000 },
  };
  await storage.controls.set(K.autonomy("sme_outreach"), "L2", "gate");
  const l3NoApproval = await promotePlaybook(storage, "sme_outreach", "L0", relaxed, "agent").then(
    () => "promoted",
    (e: Error) => e.message,
  );
  const l3Level = await storage.controls.get<string>(K.autonomy("sme_outreach"));

  // ---- 3. Experiment spend stays within the weekly explore share, while normal work still runs.
  // Give the playbook room (S3, approved on the dashboard) so the explore share is what binds.
  await post("/api/owner-approvals", { kind: "spend_tier", playbook: "sme_letter", tier: "S3" });
  const explorePort = new LocalBudgetPort(new BudgetBook(new MapKv()));
  const exploreCap = cfg.caps.explore_share * cfg.caps.global_per_day_gbp * 7;
  let exploreSpent = 0;
  let exploreRefusals = 0;
  for (let i = 0; i < 60; i++) {
    const t = await task(`exp-${i}`, "sme_letter", { experiment_id: "exp-gate" });
    try {
      const id = await reserveForStep(storage, cfg, explorePort, t, 0.4, now);
      await settleStep(storage, explorePort, id, t, 0.4, 0.4);
      exploreSpent += 0.4;
    } catch {
      exploreRefusals++;
    }
  }
  await storage.controls.set(K.queuePaused, false, "gate");
  const normal = await task("exploit-1", "sme_letter");
  const exploitStillRuns = await reserveForStep(storage, cfg, explorePort, normal, 0.2, now).then(
    () => true,
    () => false,
  );

  // ---- 4. The real runner path: a task's steps reserve and settle through the budget port.
  const service = new AgentService({
    storage,
    playbooks,
    model: fakeModel(),
    synthetic: true,
    budget: new LocalBudgetPort(),
  });
  const runTask = await task("runner-1", "sme_outreach");
  await service.runner.run(runTask.task_id);
  const ran = await storage.tasks.get(runTask.task_id);
  const runEvents = await storage.budgetEvents.forTask(runTask.task_id);
  const roleSteps = (await storage.runLog.forTask(runTask.task_id)).filter(
    (e) => e.role !== "gate",
  ).length;
  const budgets = (await (await app.request("/api/budgets")).json()) as {
    explore: { spent_this_week_gbp: number; cap_gbp: number };
    refused_today: number;
  };

  const criteria: GateCriterion[] = [
    {
      criterion: "50 parallel reservations can't exceed a cap",
      status:
        granted === Math.floor(cap / each) &&
        granted * each <= cap + 1e-9 &&
        rawOk === 25 &&
        queuePausedAfter &&
        afterSettle
          ? "passed (synthetic)"
          : "failed",
      evidence: `playbook cap £${cap}: 50 parallel £${each} reservations → ${granted} granted (£${(granted * each).toFixed(2)}), ${refused} refused, queue paused + alert; settling at the real cost freed room again; raw ledger: 50 parallel 1p against 25p → ${rawOk} granted`,
    },
    {
      criterion: "S-tier increases need Archie's recorded approval (lowering doesn't)",
      status:
        /needs Archie's recorded approval/.test(noApproval) &&
        /needs Archie's recorded approval/.test(forged) &&
        viaDashboard.status === 201 &&
        tierAfter === "S2" &&
        /needs Archie's recorded approval|already used/.test(reuse) &&
        lowered.status === 200 &&
        tierLowered === "S0"
          ? "passed (synthetic)"
          : "failed",
      evidence: `without approval: refused; made-up approval: refused; approved on the dashboard → S2; same approval reused for S3: refused; lowered to S0 with no approval`,
    },
    {
      criterion: "L3 autonomy needs Archie's recorded approval",
      status:
        /needs Archie's recorded approval/.test(l3NoApproval) && l3Level === "L2"
          ? "passed (synthetic)"
          : "failed",
      evidence: `promotion L2 → L3 without approval: "${l3NoApproval}"; level stays ${l3Level}`,
    },
    {
      criterion: "Experiment spend stays within the weekly explore share; normal work still runs",
      status:
        exploreSpent <= exploreCap + 1e-9 &&
        exploreSpent > exploreCap - 0.4 - 1e-9 &&
        exploreRefusals > 0 &&
        exploitStillRuns
          ? "passed (synthetic)"
          : "failed",
      evidence: `explore share ${cfg.caps.explore_share * 100}% of £${(cfg.caps.global_per_day_gbp * 7).toFixed(2)}/week = £${exploreCap.toFixed(2)}; 60 experiment steps of £0.40 asked (playbook raised to S3 so the share is the limit) → £${exploreSpent.toFixed(2)} spent, ${exploreRefusals} refused; a normal step still got budget; dashboard shows £${budgets.explore.spent_this_week_gbp.toFixed(2)} of £${budgets.explore.cap_gbp.toFixed(2)}`,
    },
    {
      criterion: "The runner reserves before every step and settles at the real cost",
      status:
        roleSteps > 0 &&
        runEvents.length === roleSteps &&
        runEvents.every((e) => e.status === "settled" && e.actual_gbp !== null)
          ? "passed (synthetic)"
          : "failed",
      evidence: `one sme_outreach task run by the runner (now ${ran?.status}): ${roleSteps} model/tool steps → ${runEvents.length} reservations, all settled at the real cost (${runEvents.map((e) => `£${(e.actual_gbp ?? 0).toFixed(4)} of £${e.reserved_gbp.toFixed(2)} held`).join(", ")})`,
    },
  ];
  return { criteria };
}
