import { describe, expect, it } from "vitest";
import {
  CostEvent,
  DecisionLogEntry,
  GraphApproval,
  GraphEdge,
  GraphNode,
  GraphSpec,
  graphEventType,
  RevenueEvent,
  SANDBOX_NOTE,
  SandboxReport,
} from "../graph.ts";

const node = (
  id: string,
  kind: GraphNode["kind"],
  ref: string,
  reads: string[] = [],
  writes: string[] = [],
) => ({
  id,
  kind,
  ref,
  reads,
  writes,
  budget: { maxCostGbp: 0.1, maxDurationS: 600 },
});

export const validSpec = () => ({
  graphId: "sme-outreach-acme",
  version: 1,
  taskId: "task-1",
  goal: "Draft one outreach email for a company whose website is out of date.",
  successMetric: { name: "reply", target: 1, unit: "replies", measuredBy: "count_replies" },
  stopConditions: ["budget reached", "rejected by Archie"],
  budgetGbp: 0.4,
  state: {
    entity_id: { type: "string" },
    brief: { type: "json" },
    draft: { type: "string" },
    verdict: { type: "enum", enumValues: ["pass", "fail"] },
  },
  inputs: ["entity_id"],
  nodes: [
    node("research", "role", "researcher", ["entity_id"], ["brief"]),
    node("draft", "role", "writer", ["brief"], ["draft"]),
    node("check", "role", "checker", ["brief", "draft"], ["verdict"]),
    node("approve", "approval", "archie", ["draft"], []),
  ],
  edges: [
    { from: "research", to: "draft" },
    { from: "draft", to: "check" },
    { from: "check", to: "approve", when: { key: "verdict", op: "eq", value: "pass" } },
    {
      from: "check",
      to: "draft",
      when: { key: "verdict", op: "eq", value: "fail" },
      loop: { maxIterations: 2 },
    },
  ],
  entry: "research",
  exits: ["approve"],
  planner: {
    model: "claude-opus-5-5",
    promptVersion: "1",
    rationale: "Reuses the outreach shape.",
    assumptions: [],
  },
});

const issues = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.message);

describe("GraphSpec schema", () => {
  it("accepts a valid spec (state fields default untrusted: false)", () => {
    const r = GraphSpec.safeParse(validSpec());
    expect(issues(r)).toEqual([]);
    expect(r.success && r.data.state.brief?.untrusted).toBe(false);
  });

  it("rejects a planner-set lane (computed by the compiler only)", () => {
    const s = validSpec();
    (s.state.brief as Record<string, unknown>).lane = "open";
    expect(GraphSpec.safeParse(s).success).toBe(false);
  });

  it("rejects enum fields without values, and values on non-enum fields", () => {
    const a = validSpec();
    a.state.verdict = { type: "enum" } as never;
    expect(issues(GraphSpec.safeParse(a)).join()).toMatch(/enum fields need enumValues/);
    const b = validSpec();
    b.state.draft = { type: "string", enumValues: ["x"] } as never;
    expect(issues(GraphSpec.safeParse(b)).join()).toMatch(/only on enum fields/);
  });

  it("rejects unknown nodes in entry, exits and edges, duplicate ids, and undeclared state keys", () => {
    const s = validSpec();
    s.entry = "nope";
    s.edges.push({ from: "draft", to: "ghost" });
    s.nodes.push(node("draft", "role", "writer"));
    s.nodes[0]?.reads.push("missing_key");
    const msgs = issues(GraphSpec.safeParse(s)).join(" | ");
    expect(msgs).toMatch(/unknown node nope/);
    expect(msgs).toMatch(/unknown node ghost/);
    expect(msgs).toMatch(/duplicate node id draft/);
    expect(msgs).toMatch(/undeclared state key missing_key/);
  });

  it("rejects extra fields anywhere (a graph can't smuggle in code or permissions)", () => {
    const s = validSpec() as Record<string, unknown>;
    s.code = "process.exit()";
    expect(GraphSpec.safeParse(s).success).toBe(false);
    const n = validSpec();
    (n.nodes[0] as Record<string, unknown>).permissions = ["send_email"];
    expect(GraphSpec.safeParse(n).success).toBe(false);
  });

  it("node ids and keys are snake_case ≤ 40 chars; refs must suit their kind", () => {
    expect(GraphNode.safeParse(node("Bad-Id", "role", "writer")).success).toBe(false);
    expect(GraphNode.safeParse(node(`a${"b".repeat(40)}`, "role", "writer")).success).toBe(false);
    expect(GraphNode.safeParse(node("x", "role", "planner")).success).toBe(false);
    expect(GraphNode.safeParse(node("x", "subgraph", "sme_outreach@2")).success).toBe(true);
    expect(GraphNode.safeParse(node("x", "subgraph", "sme_outreach")).success).toBe(false);
    expect(GraphNode.safeParse(node("x", "approval", "anyone")).success).toBe(false);
  });

  it("edges: ops need values; in needs a list; loop iterations bounded", () => {
    expect(GraphEdge.safeParse({ from: "a", to: "b", when: { key: "k", op: "eq" } }).success).toBe(
      false,
    );
    expect(
      GraphEdge.safeParse({ from: "a", to: "b", when: { key: "k", op: "exists" } }).success,
    ).toBe(true);
    expect(
      GraphEdge.safeParse({ from: "a", to: "b", when: { key: "k", op: "in", value: "x" } }).success,
    ).toBe(false);
    expect(GraphEdge.safeParse({ from: "a", to: "b", loop: { maxIterations: 11 } }).success).toBe(
      false,
    );
  });

  it("parentVersion must be older than version", () => {
    const s = { ...validSpec(), version: 2, parentVersion: 2 };
    expect(issues(GraphSpec.safeParse(s)).join()).toMatch(/parentVersion must be older/);
  });
});

describe("Workflow event names", () => {
  it("use only [A-Za-z0-9_-] and fit in 100 characters at the longest ids", () => {
    const t = graphEventType("ga", "f".repeat(32), "n".repeat(40), 999);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(() => graphEventType("gd", "bad.run", "x", 0)).toThrow(/invalid Workflow event type/);
  });
});

describe("reports, approvals and ledgers", () => {
  it("a sandbox report must carry the fixed note", () => {
    const r = {
      graphId: "sme-outreach-acme",
      version: 1,
      attempt: 1,
      asOf: "2026-11-18",
      scenario: "happy_path",
      mode: "sandbox",
      model: "fake",
      pass: true,
      nodes: [],
      totals: { sandboxCostGbp: 0, projectedLiveCostGbp: 0.12, expectedValueGbp: null },
      failures: [],
      guardrailHits: [],
      runId: "a".repeat(32),
      note: SANDBOX_NOTE,
    };
    expect(SandboxReport.safeParse(r).success).toBe(true);
    expect(SandboxReport.safeParse({ ...r, note: "Proves demand." }).success).toBe(false);
  });

  it("approval record extended with graph id, version, node and comment", () => {
    expect(
      GraphApproval.safeParse({
        task_id: "t",
        step_id: "approve",
        decision: "reject",
        edited_text: null,
        decided_at: "2026-11-18T10:00:00Z",
        graph_id: "sme-outreach-acme",
        graph_version: 1,
        node_id: "approve",
        comment: "Too long",
      }).success,
    ).toBe(true);
  });

  it("cost events: only adjustments may be negative in practice; revenue refunds are negative", () => {
    const c = {
      event_id: "e1",
      at: "2026-11-18T10:00:00Z",
      run_id: null,
      graph_id: null,
      graph_version: null,
      node_id: null,
      task_id: null,
      opportunity_id: null,
      revenue_path: "sme_outreach",
      shape_fingerprint: null,
      mode: "live",
      category: "model",
      unit: "output_tokens",
      quantity: 1000,
      unit_price_gbp: 0.0000158,
      amount_gbp: 0.0158,
      price_table_version: "2026-11-18",
      synthetic: false,
      dry_run: true,
    };
    expect(CostEvent.safeParse(c).success).toBe(true);
    expect(CostEvent.safeParse({ ...c, mode: "free" }).success).toBe(false);
    expect(
      RevenueEvent.safeParse({
        event_id: "r1",
        at: "2026-11-18T10:00:00Z",
        run_id: null,
        task_id: null,
        opportunity_id: null,
        revenue_path: "sme_outreach",
        rail: "stripe",
        reference: "re_1",
        amount_gbp: -149,
        settled_at: "2026-11-18T10:00:00Z",
        test_mode: true,
      }).success,
    ).toBe(true);
  });

  it("decision log entries need a reason", () => {
    const d = {
      id: "d1",
      at: "2026-11-18T10:00:00Z",
      subject: "graph_plan",
      subject_id: "sme-outreach-acme@1",
      graph_id: "sme-outreach-acme",
      graph_version: 1,
      decision: "reject",
      reason: "Letters cost too much for this sector.",
      by: "archie",
      decision_id: null,
    };
    expect(DecisionLogEntry.safeParse(d).success).toBe(true);
    expect(DecisionLogEntry.safeParse({ ...d, reason: "" }).success).toBe(false);
  });
});
