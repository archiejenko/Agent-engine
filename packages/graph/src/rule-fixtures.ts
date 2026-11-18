import type { GraphPolicy } from "@ae/config";
import type { GraphSpec } from "@ae/contracts";
import type { CompileContext, Rule } from "./compiler.ts";
import { FUNCTION_CATALOGUE } from "./functions.ts";
import type { NodeLibrary } from "./registry-export.ts";

/**
 * One failing fixture per compiler rule (graph plan, G1), shared by the unit tests and the G1 gate.
 * A small fixed library keeps them independent of the live registry. `baseSpec()` compiles; each fixture
 * mutates it so that exactly the named rule fails.
 */
export function fixtureLibrary(policy: GraphPolicy): NodeLibrary {
  const tool = (ref: string, o: Partial<NodeLibrary["tools"][number]> = {}) => ({
    ref,
    description: ref,
    acts_externally: false,
    serves_customer: false,
    allowed_lanes: ["open", "licensed"],
    allowed_roles: ["researcher", "writer", "checker", "operator"],
    rate_limit_per_min: 60,
    cost_gbp_per_call: 0,
    keys: [],
    ...o,
  });
  return {
    registryVersion: "fixture-1",
    kinds: [
      "role",
      "tool",
      "function",
      "subgraph",
      "approval",
      "fanout",
      "join",
      "condition",
      "wait",
    ],
    roles: (["researcher", "writer", "checker", "operator"] as const).map((ref) => ({
      ref,
      model: "claude-opus-5-5",
      usd_per_mtok: { input: 4, output: 20 },
    })),
    tools: [
      tool("verified_facts"),
      tool("web_fetch"),
      tool("send_email", {
        acts_externally: true,
        allowed_lanes: ["open"],
        allowed_roles: ["operator"],
      }),
    ],
    functions: FUNCTION_CATALOGUE,
    subgraphs: [
      {
        name: "demo",
        version: 1,
        autonomy: "L1",
        revenue_path: "sme_outreach",
        steps: [
          { id: "research", role: "researcher", tools: ["verified_facts"], output: "brief" },
          { id: "draft", role: "writer", tools: [], output: "draft" },
          { id: "check", role: "checker", tools: ["verified_facts"], output: "check_out" },
          { id: "approve", gate: "archie" },
          { id: "send", role: "operator", tools: ["send_email"], output: "delivery" },
        ],
        stats: { runs: 0, success_rate: null, avg_cost_gbp: null },
      },
    ],
    approvals: [{ ref: "archie" }],
    waits: ["sleep", "event:reply", "event:payment", "event:details"],
    limits: policy.limits,
  };
}

const role = (id: string, ref: string, reads: string[], writes: string[], step = id) => ({
  id,
  kind: "role" as const,
  ref,
  reads,
  writes,
  config: { playbook: "demo", step },
  budget: { maxCostGbp: 0.04, maxDurationS: 600 },
});
const fn = (id: string, ref: string) => ({
  id,
  kind: "function" as const,
  ref,
  reads: ["entity_ref"],
  writes: ["allowed"],
  budget: { maxCostGbp: 0, maxDurationS: 60 },
});

/** A valid outreach graph: research → draft ⇄ check → approve → suppression → cooldown → send. */
export function baseSpec(): GraphSpec {
  return {
    graphId: "fixture-outreach",
    version: 1,
    taskId: "fixture-task",
    goal: "Draft and send one checked outreach email.",
    successMetric: { name: "replies", target: 1, unit: "replies", measuredBy: "count_replies" },
    stopConditions: ["budget reached"],
    budgetGbp: 0.4,
    state: {
      entity_ref: { type: "string", untrusted: false },
      feedback: { type: "string", untrusted: false },
      brief: { type: "json", untrusted: false },
      draft: { type: "json", untrusted: false },
      check_out: { type: "json", untrusted: false },
      verdict: { type: "enum", enumValues: ["pass", "fail"], untrusted: false },
      approved: { type: "boolean", untrusted: false },
      allowed: { type: "boolean", untrusted: false },
      delivery: { type: "json", untrusted: false },
    },
    inputs: ["entity_ref", "feedback"],
    nodes: [
      role("research", "researcher", ["entity_ref"], ["brief"]),
      role("draft", "writer", ["brief", "feedback"], ["draft"]),
      role("check", "checker", ["brief", "draft"], ["check_out", "verdict", "feedback"]),
      {
        id: "approve",
        kind: "approval",
        ref: "archie",
        reads: ["draft"],
        writes: ["approved", "draft"],
        budget: { maxCostGbp: 0, maxDurationS: 604800 },
      },
      fn("suppression", "suppression_check"),
      fn("cooldown", "contact_cooldown"),
      role("send", "operator", ["draft", "approved"], ["delivery"]),
    ],
    edges: [
      { from: "research", to: "draft" },
      { from: "draft", to: "check" },
      {
        from: "check",
        to: "draft",
        when: { key: "verdict", op: "eq", value: "fail" },
        loop: { maxIterations: 1 },
      },
      { from: "check", to: "approve", when: { key: "verdict", op: "eq", value: "pass" } },
      { from: "approve", to: "suppression" },
      { from: "suppression", to: "cooldown", when: { key: "allowed", op: "eq", value: true } },
      { from: "cooldown", to: "send", when: { key: "allowed", op: "eq", value: true } },
    ],
    entry: "research",
    exits: ["send", "check"],
    planner: {
      model: "claude-opus-5-5",
      promptVersion: "1",
      rationale: "fixture",
      assumptions: [],
    },
  };
}

export const baseContext = (): CompileContext => ({
  taskLane: "open",
  perTaskCapGbp: 0.5,
  earnedAutonomy: "L1",
});

type Mut = (s: GraphSpec) => void;
const node = (s: GraphSpec, id: string) =>
  s.nodes.find((n) => n.id === id) as GraphSpec["nodes"][number];

export interface RuleFixture {
  rule: Rule;
  name: string;
  mutate: Mut;
  ctx?: Partial<CompileContext>;
  policy?: (p: GraphPolicy) => GraphPolicy;
}

export const RULE_FIXTURES: RuleFixture[] = [
  {
    rule: "schema",
    name: "a spec without a goal",
    mutate: (s) => delete (s as Partial<GraphSpec>).goal,
  },
  {
    rule: "ids",
    name: "a node id with a capital and a dash",
    mutate: (s) => (node(s, "research").id = "Re-search"),
  },
  {
    rule: "references",
    name: "a role bound to a step that doesn't exist",
    mutate: (s) => ((node(s, "draft").config as Record<string, unknown>).step = "nope"),
  },
  {
    rule: "references",
    name: "a role node asking for a tool its step doesn't have (granting a permission)",
    mutate: (s) => ((node(s, "research").config as Record<string, unknown>).tools = ["send_email"]),
  },
  {
    rule: "connectivity",
    name: "a node nothing leads to",
    mutate: (s) => s.nodes.push(fn("orphan", "suppression_check")),
  },
  {
    rule: "loops",
    name: "a cycle without loop.maxIterations",
    mutate: (s) => delete (s.edges[2] as { loop?: unknown }).loop,
  },
  {
    rule: "loops",
    name: "a loop allowing more iterations than policy",
    mutate: (s) => ((s.edges[2] as { loop: { maxIterations: number } }).loop.maxIterations = 5),
  },
  {
    rule: "size",
    name: "more nodes than the policy allows",
    mutate: () => {},
    policy: (p) => ({ ...p, limits: { ...p.limits, max_nodes: 5 } }),
  },
  {
    rule: "state_flow",
    name: "reading a key nothing writes first",
    mutate: (s) => node(s, "research").reads.push("draft"),
  },
  {
    rule: "state_flow",
    name: "two parallel branches writing the same key without a reducer",
    mutate: (s) => {
      s.nodes.push(role("research2", "researcher", ["entity_ref"], ["brief"], "research"));
      s.edges.push({ from: "research", to: "research2" }, { from: "research2", to: "draft" });
      s.edges.splice(0, 1, { from: "research", to: "draft" });
      s.nodes.unshift({
        id: "start",
        kind: "function",
        ref: "suppression_check",
        reads: ["entity_ref"],
        writes: ["allowed"],
        budget: { maxCostGbp: 0, maxDurationS: 60 },
      });
      s.edges.push({ from: "start", to: "research2" });
      s.edges.push({ from: "start", to: "research" });
      s.entry = "start";
      node(s, "research2").writes = ["brief"];
      s.edges = s.edges.filter((e) => !(e.from === "research" && e.to === "research2"));
    },
  },
  {
    rule: "lane",
    name: "a licensed task with an outbound send",
    mutate: () => {},
    ctx: { taskLane: "licensed" },
  },
  {
    rule: "checker_before_outbound",
    name: "sending a draft no checker has read",
    mutate: (s) => {
      node(s, "check").reads = ["brief"];
    },
  },
  {
    rule: "untrusted",
    name: "an operator reading fetched page content",
    mutate: (s) => {
      s.state.page = { type: "string", untrusted: false };
      s.nodes.splice(1, 0, {
        id: "fetch",
        kind: "tool",
        ref: "web_fetch",
        reads: ["entity_ref"],
        writes: ["page"],
        budget: { maxCostGbp: 0, maxDurationS: 60 },
      });
      s.edges.splice(0, 1, { from: "research", to: "fetch" }, { from: "fetch", to: "draft" });
      node(s, "send").reads.push("page");
    },
  },
  {
    rule: "budget",
    name: "a worst case over the budget",
    mutate: (s) => (node(s, "draft").budget.maxCostGbp = 0.5),
  },
  {
    rule: "budget",
    name: "a budget over the per-task cap",
    mutate: (s) => (s.budgetGbp = 5),
    ctx: { perTaskCapGbp: 0.5 },
  },
  {
    rule: "autonomy",
    name: "an L1 send with no approval before it",
    mutate: (s) => {
      s.nodes = s.nodes.filter((n) => n.id !== "approve");
      s.edges = s.edges.filter((e) => e.from !== "approve" && e.to !== "approve");
      s.edges.push({
        from: "check",
        to: "suppression",
        when: { key: "verdict", op: "eq", value: "pass" },
      });
      node(s, "send").reads = ["draft"];
    },
  },
  {
    rule: "autonomy",
    name: "an external send in an L0 graph",
    mutate: () => {},
    ctx: { earnedAutonomy: "L0" },
  },
  {
    rule: "outreach",
    name: "a send without the suppression check",
    mutate: (s) => {
      s.nodes = s.nodes.filter((n) => n.id !== "suppression");
      s.edges = s.edges.filter((e) => e.from !== "suppression" && e.to !== "suppression");
      s.edges.push({ from: "approve", to: "cooldown" });
    },
  },
  {
    rule: "deterministic_edges",
    name: "branching on free text a model wrote",
    mutate: (s) => {
      s.edges[3] = { from: "check", to: "approve", when: { key: "draft", op: "exists" } };
      s.edges[2] = {
        from: "check",
        to: "draft",
        when: { key: "draft", op: "eq", value: "x" },
        loop: { maxIterations: 1 },
      };
    },
  },
  {
    rule: "deterministic_edges",
    name: "mixing conditional and unconditional edges",
    mutate: (s) => s.edges.push({ from: "check", to: "draft", loop: { maxIterations: 1 } }),
  },
  {
    rule: "steps",
    name: "more Workflow steps than the policy allows",
    mutate: () => {},
    policy: (p) => ({ ...p, limits: { ...p.limits, max_workflow_steps: 10 } }),
  },
];
