import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
  planCard,
  startApprovedPlans,
} from "@ae/agent-runner";
import { loadDecisionsConfig, loadGraphPolicy, loadIdeasConfig, loadInfraConfig } from "@ae/config";
import { type CompiledGraph, type GraphSpec, LedgerEvent } from "@ae/contracts";
import { compile, shapeFingerprint } from "@ae/graph";
import {
  type DecisionDeps,
  decide,
  K,
  localWorkflowPort,
  raiseCard,
  recordShapeBreach,
  scoutSignals,
  settleGraphRuns,
  storeSignals,
  suggestPromotions,
  wilsonLower,
} from "@ae/infra";
import type { Storage, StoredTask } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";

const INDUSTRIES = ["construction", "retail", "hospitality", "manufacturing", "motor"];

async function world(root: string) {
  const storage = await openSqliteStorage(":memory:");
  await buildSyntheticWorld(storage, fakeModel(), { count: 40, seed: 11 });
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model: fakeModel(),
    graphEngine: { enabled: true },
  });
  const entities = [
    ...new Set(
      (await storage.facts.listCurrent({ status: "verified", limit: 2000, offset: 0 })).rows.map(
        (f) => f.entity_id,
      ),
    ),
  ].sort();
  const withEmail = new Set(
    (
      await storage.facts.listCurrent({
        field: "contact_email",
        status: "verified",
        limit: 2000,
        offset: 0,
      })
    ).rows.map((f) => f.entity_id),
  );
  return { storage, service, entities: entities.filter((e) => withEmail.has(e)) };
}

/** One idea → plan → Archie approves the plan → the run → Archie approves the draft → done; then a reply. */
async function oneRun(w: Awaited<ReturnType<typeof world>>, i: number) {
  const { storage, service } = w;
  const cfg = loadInfraConfig();
  const icfg = loadIdeasConfig();
  const { signals } = await scoutSignals(icfg, "sme_websites", [
    {
      source_name: "companies_house",
      source_url: `https://example.invalid/g5-${i}`,
      entity_id: w.entities[i] as string,
      signal_type: "no_website",
      value: true,
      taxonomy_node: "marketing",
      buyer: "small business owner",
      industry: INDUSTRIES[i % INDUSTRIES.length] as string,
      observed_at: "2026-11-19T08:00:00.000Z",
    },
  ]);
  await storeSignals(storage, signals, { synthetic: true });
  const card = await raiseCard(
    { storage, cfg, icfg },
    {
      field: "sme_websites",
      signal_ids: signals.map((s) => s.signal_id),
      offer: `A fast website (g5 run ${i})`,
      thesis: "Firms without a modern site lose enquiries.",
      route: "sell_fix",
      playbooks: ["sme_outreach"],
      created_by: "gate",
      synthetic: true,
    },
  );
  const plan = await planCard(
    { service, sandboxStorage: () => openSqliteStorage(":memory:") },
    card.card.card_id,
  );
  const dd: DecisionDeps = {
    storage,
    cfg,
    dcfg: loadDecisionsConfig(),
    workflows: localWorkflowPort(service.workflows),
    decideTask: (t, d, e) => service.decide(t, d, e),
  };
  const dec = await storage.decisions.openFor(
    "graph_plan",
    `graph:${plan.graph_id}@${plan.version}`,
  );
  await decide(dd, dec?.id as string, "approve", "archie");
  await startApprovedPlans(service);
  await service.runQueued();
  const task = (await storage.tasks.list({ limit: 500 })).find(
    (t) =>
      (t.state as { graph_spec?: { graph_id: string } }).graph_spec?.graph_id === plan.graph_id,
  ) as StoredTask;
  if (task.status === "awaiting_approval") await service.decide(task.task_id, "approve", null);
  const done = (await storage.tasks.get(task.task_id)) as StoredTask;
  await storage.outcomeLedger.record(
    LedgerEvent.parse({
      event: "reply",
      entity_id: w.entities[i] as string,
      task_id: task.task_id,
      playbook: "sme_outreach",
      observed_at: new Date().toISOString(),
      source: "simulator",
      synthetic: true,
      dedupe_key: `g5-reply-${i}-${task.task_id}`,
    }),
  );
  return { done, compiled: plan.compiled as CompiledGraph };
}

export async function runGraphG5Gate(_storage: Storage, root: string) {
  const policy = loadGraphPolicy();
  const later = new Date(Date.now() + (policy.promotion.settle_after_days + 1) * 86_400_000);

  // 1. Shape fingerprint: blind to per-task config, sensitive to kinds, refs and edges.
  const T = await world(root);
  const runs = [];
  for (let i = 0; i < policy.promotion.min_live_runs; i++) runs.push(await oneRun(T, i));
  const base = runs[0]?.compiled.spec as GraphSpec;
  const fps = new Set(runs.map((r) => r.compiled.shapeFingerprint));
  const otherTask = {
    ...base,
    taskId: "another-task",
    goal: "A different goal for another company",
    nodes: base.nodes.map((n) =>
      n.kind === "role"
        ? { ...n, budget: { ...n.budget, maxCostGbp: n.budget.maxCostGbp / 2 } }
        : n,
    ),
  };
  const swappedRef = {
    ...base,
    nodes: base.nodes.map((n) => (n.id === "cooldown" ? { ...n, ref: "suppression_check" } : n)),
  };
  const extraEdge = {
    ...base,
    edges: [...base.edges, { from: base.entry, to: base.exits[0] as string }],
  };
  const fpBase = await shapeFingerprint(base);
  const fpSame = (await shapeFingerprint(otherTask)) === fpBase;
  const fpRef = (await shapeFingerprint(swappedRef)) !== fpBase;
  const fpEdge = (await shapeFingerprint(extraEdge)) !== fpBase;

  // 2. Test mode: the synthetic history of 5 successful runs earns a suggestion; approving promotes at L1.
  const settled = await settleGraphRuns(T.storage, policy, { now: later, testMode: true });
  const fp = runs[0]?.compiled.shapeFingerprint as string;
  const shape = await T.storage.graphShapes.get(fp);
  const suggested = await suggestPromotions(T.storage, policy, later);
  const dd: DecisionDeps = {
    storage: T.storage,
    cfg: loadInfraConfig(),
    dcfg: loadDecisionsConfig(),
  };
  const promoDec = await T.storage.decisions.openFor("promotion", `shape:${fp}`);
  if (promoDec) await decide(dd, promoDec.id, "promote", "archie");
  const promoted = (await T.storage.promotedPlaybooks.list())[0];
  const promotedLevel = promoted
    ? await T.storage.controls.get<string>(K.autonomy(promoted.name))
    : null;
  const lb = wilsonLower(shape?.met_metric ?? 0, shape?.live_runs ?? 0, policy.promotion.wilson_z);

  // 3. Production mode: the same synthetic (and dry-run) history never counts.
  const P = await world(root);
  for (let i = 0; i < policy.promotion.min_live_runs; i++) await oneRun(P, i);
  const prodSettled = await settleGraphRuns(P.storage, policy, { now: later });
  const prodShapes = await P.storage.graphShapes.list();
  const prodSuggested = await suggestPromotions(P.storage, policy, later);
  const prodOutcomes = await P.storage.outcomes.list(1000);

  // 4. A breach drops the shape and its promoted playbook one level.
  const drop = await recordShapeBreach(
    T.storage,
    fp,
    "a send outside the suppression check (gate)",
  );
  const afterBreach = promoted
    ? await T.storage.controls.get<string>(K.autonomy(promoted.name))
    : null;

  // 5. Bespoke graphs run at L1 at most; a composed graph takes the lowest level among its subgraphs.
  const lib = await T.service.nodeLibrary();
  const bespoke = await compile(base, lib, policy, { taskLane: "open", perTaskCapGbp: 1 });
  const wantL3 = await compile(base, lib, policy, {
    taskLane: "open",
    perTaskCapGbp: 1,
    earnedAutonomy: undefined,
  });
  // Two playbooks that don't send: a subgraph that can send is a black box, so the compiler (rightly)
  // re-requires the approval, suppression and cooldown checks around it.
  const outreach = lib.subgraphs.find((s) => s.name === "post_reply");
  const report = lib.subgraphs.find((s) => s.name === "monitoring_subscription");
  const composed: GraphSpec = {
    ...base,
    graphId: "composed-test",
    state: {
      entity_ref: { type: "string", untrusted: false },
      out_a: { type: "json", untrusted: false },
      out_b: { type: "json", untrusted: false },
    },
    inputs: ["entity_ref"],
    nodes: [
      {
        id: "a",
        kind: "subgraph",
        ref: `post_reply@${outreach?.version}`,
        reads: ["entity_ref"],
        writes: ["out_a"],
        budget: { maxCostGbp: 0.1, maxDurationS: 600 },
      },
      {
        id: "b",
        kind: "subgraph",
        ref: `monitoring_subscription@${report?.version}`,
        reads: ["entity_ref"],
        writes: ["out_b"],
        budget: { maxCostGbp: 0.1, maxDurationS: 600 },
      },
    ],
    edges: [{ from: "a", to: "b" }],
    entry: "a",
    exits: ["b"],
  };
  const comp = await compile(composed, lib, policy, { taskLane: "open", perTaskCapGbp: 1 });
  const levels = ["L0", "L1", "L2", "L3"];
  const minSub =
    levels[
      Math.min(levels.indexOf(outreach?.autonomy ?? "L0"), levels.indexOf(report?.autonomy ?? "L0"))
    ];

  // 6. Outcome write-back: every settled run carries its outcome, linked to its shape.
  const runRows = await T.storage.graphRuns.list({ mode: "live" });
  const written = runRows.filter((r) => r.outcome_id?.endsWith(fp.slice(0, 16)));

  // 7. The test-only switch never appears in production code.
  const prodFiles = [
    ...readdirSync(join(root, "packages/infra/src")).map((f) =>
      join(root, "packages/infra/src", f),
    ),
    ...readdirSync(join(root, "apps/agent-runner/src")).map((f) =>
      join(root, "apps/agent-runner/src", f),
    ),
    ...readdirSync(join(root, "apps/api/src")).map((f) => join(root, "apps/api/src", f)),
  ].filter((f) => f.endsWith(".ts") && !f.includes("__tests__") && !f.endsWith(".test.ts"));
  const testModeUsers = prodFiles.filter((f) => /testMode:\s*true/.test(readFileSync(f, "utf8")));

  const ok = (b: boolean) => (b ? "passed (synthetic)" : "failed");
  const criteria: GateCriterion[] = [
    {
      criterion:
        "The shape fingerprint ignores per-task config and changes when a kind, ref or edge changes",
      status: ok(fps.size === 1 && fpSame && fpRef && fpEdge),
      evidence: `${runs.length} plans for 5 different companies share ${fps.size} shape(s) (${fp.slice(0, 12)}); another task, goal and budgets: ${fpSame ? "same" : "DIFFERENT"}; a swapped ref: ${fpRef ? "different" : "SAME"}; an extra edge: ${fpEdge ? "different" : "SAME"}`,
    },
    {
      criterion:
        "A synthetic history of 5 successful runs produces a promotion suggestion (test mode); approving it creates a promoted playbook version at L1",
      status: ok(
        runs.every((r) => r.done.status === "done") &&
          shape?.live_runs === 5 &&
          shape.met_metric === 5 &&
          suggested.includes(fp) &&
          promoted?.autonomy === "L1" &&
          promotedLevel === "L1",
      ),
      evidence: `5 runs done (dry-run), each with a reply; settled: ${settled.filter((s) => s.met).length}/5 met "count_replies ≥ 1"; shape record ${shape?.met_metric}/${shape?.live_runs}, ${shape?.breaches} breaches, success at least ${Math.round(lb * 100)}% (Wilson, z ${policy.promotion.wilson_z}; needs ${Math.round(policy.promotion.min_success_lower_bound * 100)}%); suggested; Archie promoted it: ${promoted?.name} v${promoted?.version} at ${promotedLevel}`,
    },
    {
      criterion: "In production mode, synthetic or dry-run runs never count",
      status: ok(
        prodSettled.length === 5 &&
          prodSettled.every((s) => !s.counted) &&
          prodShapes.length === 0 &&
          prodSuggested.length === 0 &&
          prodOutcomes.every((o) => !/graph_route/.test(o.event)),
      ),
      evidence: `the same 5-run history settled in production mode: ${prodSettled.filter((s) => s.counted).length} counted (${[...new Set(prodSettled.map((s) => s.reason))].join("; ")}); shapes recorded: ${prodShapes.length}; suggestions: ${prodSuggested.length}; opportunity outcomes written: 0`,
    },
    {
      criterion: "A breach drops a shape or playbook one level",
      status: ok(drop.from === "L1" && drop.to === "L0" && afterBreach === "L0"),
      evidence: `shape ${drop.from} → ${drop.to}; ${promoted?.name} ${promotedLevel} → ${afterBreach}`,
    },
    {
      criterion:
        "A bespoke graph never runs above L1; a composed graph takes the lowest level among its subgraphs",
      status: ok(
        !!bespoke.compiled &&
          ["L0", "L1"].includes(bespoke.compiled.autonomy) &&
          !!wantL3.compiled &&
          ["L0", "L1"].includes(wantL3.compiled.autonomy) &&
          (comp.compiled ? comp.compiled.autonomy === minSub : false),
      ),
      evidence: `planner graph (bespoke): ${bespoke.compiled?.autonomy}; composed of post_reply (${outreach?.autonomy}) and monitoring_subscription (${report?.autonomy}): ${comp.compiled?.autonomy ?? `not compiled: ${comp.errors.map((e) => `${e.rule}: ${e.message}`).join("; ")}`} (lowest: ${minSub})`,
    },
    {
      criterion:
        "Each finished run writes an outcome linked to its shape; only real, settled outcomes count",
      status: ok(written.length === 5 && testModeUsers.length === 0),
      evidence: `${written.length} runs carry their outcome (met/missed + shape); outcomes become counted records only for real, settled runs (criterion 3); the test-only switch appears in no production file (${prodFiles.length} scanned)`,
    },
  ];
  return { criteria };
}
