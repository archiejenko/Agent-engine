import { loadGraphPolicy } from "@ae/config";
import { type CompiledGraph, type CompileError, GraphSpec, type IdeaCard } from "@ae/contracts";
import { checkProbe, compile, type NodeLibrary } from "@ae/graph";
import {
  bundledGraph,
  bundledPrompt,
  MAX_PLAN_ATTEMPTS,
  meteredModel,
  openPlanDecision,
  planGraphId,
  splitFrontMatter,
  withMeter,
} from "@ae/infra";
import type { ModelClient } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { z } from "zod";
import { failureScenarios, HAPPY_PATH, runSandbox, type SandboxRunResult } from "./sandbox.ts";
import type { AgentService } from "./service.ts";

/**
 * Task graph G4: the planner, a fifth role. It turns an approved idea into a GraphSpec. Its only "tools"
 * are its two answers: submit_graph and request_probe. Code does everything else:
 *   - it builds the input from STRUCTURED data only (the card, the node library, the playbook catalogue,
 *     policy limits, a suggested budget, and on revision the compiler's errors, the sandbox report, probe
 *     reports and Archie's comments from the decision log). No fetched page or email is ever read here.
 *   - it sets the graph's id, version, task and planner metadata; the planner can't approve its graph,
 *     raise its budget (the compiler is given the suggested budget as the cap), or use anything outside
 *     the library (compiler rule "references").
 *   - at most 3 attempts and 2 probes per idea; after the third failure the idea shows "couldn't plan".
 */

export interface PlannerPrompt {
  version: string;
  promptId: string;
  system: string;
}
export async function plannerPrompt(): Promise<PlannerPrompt> {
  const text = await bundledPrompt("_planner");
  if (!text) throw new Error("playbooks/_planner/SKILL.md isn't bundled (run pnpm gen:playbooks)");
  const { data, body } = splitFrontMatter(text);
  return { version: String(data.version), promptId: String(data.prompt_id), system: body.trim() };
}

const Submit = z.object({
  action: z.literal("submit_graph"),
  spec: z.unknown(),
  rationale: z.string().min(1).max(2000),
  assumptions: z.array(z.string().min(1)).default([]),
});
const Probe = z.object({
  action: z.literal("request_probe"),
  spec: z.unknown(),
  question: z.string().min(1).max(500),
});
const PlannerAnswer = z.discriminatedUnion("action", [Submit, Probe]);

export interface ProbeReport {
  question: string;
  ok: boolean;
  problems: string[];
  nodes: { nodeId: string; status: string; costGbp: number }[];
  cost_gbp: number;
}
export interface AttemptReport {
  version: number;
  compile_errors: CompileError[];
  sandbox: {
    scenario: string;
    pass: boolean;
    failures: string[];
    nodes: { nodeId: string; status: string; costGbp: number }[];
    cost_gbp: number;
    projected_live_gbp: number;
  }[];
}

export interface PlannerInput {
  idea: {
    card_id: string;
    version: number;
    offer: string;
    thesis: string;
    market: { buyer: string; industry: string | null };
    function: string;
    route: string;
    lane: string;
    playbooks: string[];
    expected_value_per_task_gbp: number;
    fact_refs: string[];
    signal_refs: string[];
  };
  node_library: NodeLibrary;
  catalogue: {
    playbook: string;
    version: number;
    autonomy: string;
    stats: unknown;
    graph: unknown;
  }[];
  policy_limits: ReturnType<typeof loadGraphPolicy>["limits"];
  suggested_budget_gbp: number;
  attempt: number;
  max_attempts: number;
  probes_left: number;
  previous: AttemptReport | null;
  previous_spec: unknown | null;
  probe_reports: ProbeReport[];
  archie_feedback: { decision: string; reason: string }[];
}

/** 20% of the expected value per task (P(paid) × first-year value), capped by the per-task limit. */
export function suggestedBudget(
  card: IdeaCard,
  perTaskCapGbp: number,
  evShare = loadGraphPolicy().budget.ev_share,
) {
  const ev = card.economics.cost_to_acquire.p_paid.value * card.economics.first_year_value.value;
  return Math.round(Math.min(ev * evShare, perTaskCapGbp) * 100) / 100;
}

export interface PlannerDeps {
  service: AgentService;
  model?: ModelClient;
  /** A fresh, empty database for each sandbox or probe run (never the production one). */
  sandboxStorage: () => Promise<Storage>;
  now?: () => Date;
}

export interface PlanResult {
  status: "ready" | "couldnt_plan";
  graph_id: string;
  version: number | null;
  attempts: AttemptReport[];
  probes: ProbeReport[];
  refused: string[];
  compiled: CompiledGraph | null;
}

const summarise = (r: SandboxRunResult) => ({
  scenario: r.report.scenario,
  pass: r.report.pass,
  failures: r.report.failures,
  nodes: r.report.nodes.map((n) => ({ nodeId: n.nodeId, status: n.status, costGbp: n.costGbp })),
  cost_gbp: r.report.totals.sandboxCostGbp,
  projected_live_gbp: r.report.totals.projectedLiveCostGbp,
});

/** Plans one card: probes, attempts, sandbox; ends ready (with a decision for Archie) or couldn't plan. */
export async function planCard(d: PlannerDeps, cardId: string): Promise<PlanResult> {
  const { service } = d;
  const storage = service.storage;
  // Every planner call writes its own cost event at call time (mode "planner": never live spend).
  const model = withMeter(
    meteredModel(d.model ?? service.model, {
      storage,
      models: service.graphDeps.models,
      mode: "planner",
    }),
    { mode: "planner" },
  );
  const policy = loadGraphPolicy();
  const prompt = await plannerPrompt();
  const row = await storage.ideaCards.latest(cardId);
  if (!row) throw new Error("no such card");
  const card = row.card as IdeaCard;
  const graphId = planGraphId(cardId);
  const pbName = card.playbooks[0] as string;
  const pb = service.playbooks.get(pbName);
  if (!pb) throw new Error(`no playbook ${pbName}`);
  const lib = await service.nodeLibrary();
  const budget = suggestedBudget(card, pb.spec.budget_gbp, policy.budget.ev_share);
  const catalogue = await Promise.all(
    lib.subgraphs.map(async (s) => ({
      playbook: s.name,
      version: s.version,
      autonomy: s.autonomy,
      stats: s.stats,
      graph: await bundledGraph(s.name),
    })),
  );

  const existing = await storage.graphSpecs.versions(graphId);
  const attempts: AttemptReport[] = [];
  const probes: ProbeReport[] = [];
  const refused: string[] = [];
  let previous: AttemptReport | null = null;
  let previousSpec: unknown | null = existing.at(-1)?.spec ?? null;
  let used = existing.length;
  const maxCalls = MAX_PLAN_ATTEMPTS + policy.sandbox.max_probes;
  for (let call = 0; call < maxCalls && used < MAX_PLAN_ATTEMPTS; call++) {
    const feedback = [
      ...(await storage.decisionLog.forSubject("graph_plan", graphId)),
      ...(await storage.decisionLog.forSubject("idea", cardId)),
    ].map((l) => ({ decision: l.decision, reason: l.reason }));
    const input: PlannerInput = {
      idea: {
        card_id: card.card_id,
        version: card.version,
        offer: card.offer,
        thesis: card.thesis,
        market: { buyer: card.market.buyer, industry: card.market.industry },
        function: card.taxonomy_node,
        route: card.route,
        lane: card.lane,
        playbooks: card.playbooks,
        expected_value_per_task_gbp:
          card.economics.cost_to_acquire.p_paid.value * card.economics.first_year_value.value,
        fact_refs: card.evidence.fact_ids,
        signal_refs: card.evidence.signal_ids,
      },
      node_library: lib,
      catalogue,
      policy_limits: policy.limits,
      suggested_budget_gbp: budget,
      attempt: used + 1,
      max_attempts: MAX_PLAN_ATTEMPTS,
      probes_left: policy.sandbox.max_probes - probes.length,
      previous,
      previous_spec: previousSpec,
      probe_reports: probes,
      archie_feedback: feedback,
    };
    const res = await model.complete({
      prompt_id: prompt.promptId,
      prompt_version: Number(prompt.version) || 1,
      role: "planner",
      system: prompt.system,
      user: JSON.stringify(input),
      max_tokens: 8000,
      meter: { mode: "planner", graph_id: graphId, opportunity_id: cardId },
    });
    const parsed = (() => {
      try {
        return PlannerAnswer.safeParse(JSON.parse(res.text));
      } catch {
        return { success: false as const };
      }
    })();
    if (!parsed.success) {
      used++;
      previous = {
        version: used,
        compile_errors: [
          {
            rule: "schema",
            nodeId: null,
            message: "the answer wasn't a valid submit_graph or request_probe",
          },
        ],
        sandbox: [],
      };
      attempts.push(previous);
      continue;
    }
    const answer = parsed.data;

    if (answer.action === "request_probe") {
      if (probes.length >= policy.sandbox.max_probes) {
        refused.push(
          `probe ${probes.length + 1} refused: at most ${policy.sandbox.max_probes} per idea`,
        );
        continue;
      }
      const pr = await runProbe(d, lib, answer.spec, answer.question, graphId, budget, card);
      probes.push(pr);
      // Kept in the main database so the approval card can show it (its run happened in a sandbox).
      await storage.sandboxReports.add({
        id: crypto.randomUUID(),
        graph_id: `${graphId}-probe`.slice(0, 64),
        version: probes.length,
        attempt: Math.min(3, Math.max(1, used + 1)),
        scenario: "probe",
        mode: "probe",
        as_of: (d.now?.() ?? new Date()).toISOString(),
        pass: pr.ok,
        report: pr,
        sandbox_cost_gbp: pr.cost_gbp,
        projected_live_cost_gbp: pr.cost_gbp,
        run_id: "0".repeat(32),
      });
      continue;
    }

    // submit_graph: code sets identity and metadata; the planner can't.
    used++;
    const version = used;
    const raw = (answer.spec ?? {}) as Record<string, unknown>;
    const specTry = GraphSpec.safeParse({
      ...raw,
      graphId,
      version,
      ...(version > 1 ? { parentVersion: version - 1 } : {}),
      taskId: `plan-${cardId}`.slice(0, 80),
      opportunityId: cardId,
      planner: {
        model: model.name,
        promptVersion: prompt.version,
        rationale: answer.rationale,
        assumptions: answer.assumptions,
      },
    });
    if (!specTry.success) {
      previous = {
        version,
        compile_errors: specTry.error.issues.slice(0, 20).map((i) => ({
          rule: "schema",
          nodeId: null,
          message: `${i.path.join(".")}: ${i.message}`,
        })),
        sandbox: [],
      };
      attempts.push(previous);
      continue;
    }
    const spec = specTry.data;
    previousSpec = spec;
    await storage.graphSpecs.add({
      graph_id: graphId,
      version,
      parent_version: version > 1 ? version - 1 : null,
      task_id: spec.taskId,
      opportunity_id: cardId,
      hypothesis_id: card.hypothesis_id,
      spec,
      content_hash: null,
      registry_version: null,
      compiled: null,
      lane: null,
      worst_case_cost_gbp: null,
      autonomy: null,
      shape_fingerprint: null,
      status: "drafting",
      attempt: version,
      synthetic: row.synthetic,
      created_by: `planner (${model.name}, prompt v${prompt.version})`,
    });
    // The budget cap is the suggested budget: a planner can't raise its own.
    const r = await compile(spec, lib, policy, { taskLane: card.lane, perTaskCapGbp: budget });
    if (!r.compiled) {
      previous = { version, compile_errors: r.errors, sandbox: [] };
      attempts.push(previous);
      await storage.graphSpecs.setStatus(graphId, version, "superseded");
      continue;
    }
    const c = r.compiled;
    await storage.graphSpecs.setCompiled(graphId, version, {
      content_hash: c.contentHash,
      registry_version: c.registryVersion,
      compiled: c,
      lane: c.lane,
      worst_case_cost_gbp: c.worstCaseCostGbp,
      autonomy: c.autonomy,
      shape_fingerprint: c.shapeFingerprint,
    });
    await storage.graphSpecs.setStatus(graphId, version, "sandboxing");
    // Sandbox: the happy path and its failure scenarios, each in a fresh database.
    const results: SandboxRunResult[] = [];
    const happy = await runSandbox({
      storage: await d.sandboxStorage(),
      playbooks: service.playbooks,
      playbook: pbName,
      scenario: HAPPY_PATH,
      compiled: c,
      attempt: version,
    });
    results.push(happy);
    for (const sc of failureScenarios(happy).slice(0, 2))
      results.push(
        await runSandbox({
          storage: await d.sandboxStorage(),
          playbooks: service.playbooks,
          playbook: pbName,
          scenario: sc,
          compiled: c,
          attempt: version,
        }),
      );
    for (const x of results)
      await storage.sandboxReports.add({
        id: crypto.randomUUID(),
        graph_id: graphId,
        version,
        attempt: version,
        scenario: x.report.scenario,
        mode: "sandbox",
        as_of: x.report.asOf,
        pass: x.report.pass,
        report: x.report,
        sandbox_cost_gbp: x.report.totals.sandboxCostGbp,
        projected_live_cost_gbp: x.report.totals.projectedLiveCostGbp,
        run_id: x.report.runId,
      });
    previous = { version, compile_errors: [], sandbox: results.map(summarise) };
    attempts.push(previous);
    if (!happy.report.pass) {
      await storage.graphSpecs.setStatus(graphId, version, "superseded");
      continue;
    }
    await storage.graphSpecs.setStatus(graphId, version, "ready");
    const ready = await storage.graphSpecs.get(graphId, version);
    if (ready)
      await openPlanDecision(
        storage,
        ready,
        card.economics.expected_profit.value,
        d.now?.() ?? new Date(),
      );
    return { status: "ready", graph_id: graphId, version, attempts, probes, refused, compiled: c };
  }
  // Out of attempts: the idea goes back to the feed as "couldn't plan", with every report attached.
  let last = (await storage.graphSpecs.versions(graphId)).at(-1);
  if (last) await storage.graphSpecs.setStatus(graphId, last.version, "couldnt_plan");
  else {
    // No graph was ever submitted (only probes, or nothing usable): still record the outcome.
    await storage.graphSpecs.add({
      graph_id: graphId,
      version: 1,
      parent_version: null,
      task_id: `plan-${cardId}`.slice(0, 80),
      opportunity_id: cardId,
      hypothesis_id: card.hypothesis_id,
      spec: { none: "the planner never submitted a usable graph" },
      content_hash: null,
      registry_version: null,
      compiled: null,
      lane: null,
      worst_case_cost_gbp: null,
      autonomy: null,
      shape_fingerprint: null,
      status: "couldnt_plan",
      attempt: 1,
      synthetic: row.synthetic,
      created_by: `planner (${model.name}, prompt v${prompt.version})`,
    });
    last = (await storage.graphSpecs.versions(graphId)).at(-1);
  }
  return {
    status: "couldnt_plan",
    graph_id: graphId,
    version: last?.version ?? null,
    attempts,
    probes,
    refused,
    compiled: null,
  };
}

async function runProbe(
  d: PlannerDeps,
  lib: NodeLibrary,
  rawSpec: unknown,
  question: string,
  graphId: string,
  budget: number,
  card: IdeaCard,
): Promise<ProbeReport> {
  const policy = loadGraphPolicy();
  const n = (await d.service.storage.sandboxReports.forGraph(`${graphId}-probe`.slice(0, 64)))
    .length;
  const spec = GraphSpec.safeParse({
    ...((rawSpec ?? {}) as object),
    graphId: `${graphId}-probe`.slice(0, 64),
    version: n + 1,
    taskId: `probe-${card.card_id}`.slice(0, 80),
    planner: {
      model: "planner",
      promptVersion: (await plannerPrompt()).version,
      rationale: question,
      assumptions: [],
    },
  });
  if (!spec.success)
    return {
      question,
      ok: false,
      problems: spec.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`),
      nodes: [],
      cost_gbp: 0,
    };
  const problems = checkProbe(spec.data, lib, policy).map(
    (e) => `${e.nodeId ?? "graph"}: ${e.message}`,
  );
  if (problems.length) return { question, ok: false, problems, nodes: [], cost_gbp: 0 };
  const r = await compile(spec.data, lib, policy, {
    taskLane: card.lane,
    perTaskCapGbp: Math.min(budget, policy.sandbox.max_cost_per_attempt_gbp),
  });
  if (!r.compiled)
    return {
      question,
      ok: false,
      problems: r.errors.map((e) => `${e.rule}: ${e.message}`),
      nodes: [],
      cost_gbp: 0,
    };
  const res = await runSandbox({
    storage: await d.sandboxStorage(),
    playbooks: d.service.playbooks,
    playbook: card.playbooks[0] as string,
    scenario: {
      name: "probe",
      failure: false,
      decisions: [],
      expect: ["done", "running", "awaiting_approval", "cancelled"],
    },
    compiled: r.compiled,
    mode: "probe",
  });
  return {
    question,
    ok: res.report.pass,
    problems: res.report.failures,
    nodes: res.report.nodes.map((x) => ({
      nodeId: x.nodeId,
      status: x.status,
      costGbp: x.costGbp,
    })),
    cost_gbp: res.report.totals.sandboxCostGbp,
  };
}

/** Plans every passed idea that has no plan yet, or whose last plan Archie sent back with an edit. */
export { fakePlanner } from "./fake-planner.ts";

export async function planPendingCards(d: PlannerDeps, limit = 10): Promise<PlanResult[]> {
  // The whole graph layer sits behind GRAPH_ENGINE_ENABLED: off, nothing is planned.
  if (!d.service.graphEngine.enabled) return [];
  const storage = d.service.storage;
  const out: PlanResult[] = [];
  const cards = await storage.ideaCards.list({ status: ["passed", "testing", "budget_pending"] });
  for (const c of cards.slice(0, limit)) {
    const specs = await storage.graphSpecs.versions(planGraphId(c.card_id));
    const last = specs.at(-1);
    const wants = !last || (last.status === "superseded" && specs.length < MAX_PLAN_ATTEMPTS);
    if (wants) out.push(await planCard(d, c.card_id));
    else if (last?.status === "superseded" && specs.length >= MAX_PLAN_ATTEMPTS)
      await storage.graphSpecs.setStatus(last.graph_id, last.version, "couldnt_plan");
  }
  return out;
}

/** Each approved plan gets one task that runs its graph (dry-run). Idempotent on the plan version. */
export async function startApprovedPlans(service: AgentService): Promise<number> {
  if (!service.graphEngine.enabled) return 0; // behind GRAPH_ENGINE_ENABLED, like every graph run
  const { storage } = service;
  let n = 0;
  for (const g of await storage.graphSpecs.list({ status: "approved", limit: 100 })) {
    if (!g.opportunity_id?.startsWith("card-")) continue;
    const card = (await storage.ideaCards.latest(g.opportunity_id))?.card as IdeaCard | undefined;
    if (!card) continue;
    const sig = await storage.scoutSignals.get(card.evidence.signal_ids[0] ?? "");
    const entity = sig?.entity_id ?? "unknown";
    const pb = service.playbooks.get(card.playbooks[0] as string);
    if (!pb) continue;
    const { createTask } = await import("@ae/infra");
    const r = await createTask(storage, service.infra, service.playbooks, service.queue, {
      idempotency_key: `plan:${g.graph_id}@${g.version}`,
      playbook: pb.spec.playbook,
      revenue_path: pb.spec.revenue_path as never,
      source_ref: `card:${card.card_id}:entity:${entity}`,
      lane: card.lane,
      synthetic: g.synthetic,
      state: { graph_spec: { graph_id: g.graph_id, version: g.version } },
    });
    if (r.created) n++;
  }
  return n;
}
