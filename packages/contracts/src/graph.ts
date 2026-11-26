import { z } from "zod";
import { Gbp, IsoDate, IsoDateOrDateTime, IsoDateTime, Lane } from "./common.ts";
import { Autonomy, Role } from "./infra.ts";

/**
 * Task graph contracts (graph plan, G0). A graph is DATA, never code: a JSON GraphSpec built only from
 * registered node kinds. These schemas check shape only. Everything structural (references, reachability,
 * loops, size, state flow, lanes, checker-before-outbound, untrusted content, budget, autonomy placement,
 * outreach checks, deterministic edges) is the deterministic compiler's job (packages/graph, G1).
 */

/** Node ids and state keys: snake_case, at most 40 characters, so Workflow event types always fit. */
export const GraphKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "lowercase letters, digits and _ only; at most 40 characters");
export const GraphId = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
/** 32 lowercase hex characters (a UUID without dashes). */
export const RunId = z.string().regex(/^[0-9a-f]{32}$/);
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const NodeKind = z.enum([
  "role", // one agent step: researcher | writer | checker | operator
  "tool", // one tool call from the tool registry
  "function", // a registered deterministic function (cost, EV, scoring, transforms, checks)
  "subgraph", // a promoted playbook, playbookId@version
  "approval", // pause for Archie: approve | edit | reject
  "fanout", // run one child over a list, parallel width capped
  "join", // merge parallel results using the state key's reducer
  "condition", // deterministic branch on a state value
  "wait", // sleep, or wait for an external event (reply, payment)
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const StateType = z.enum(["string", "number", "boolean", "enum", "json", "list"]);
export const Reducer = z.enum(["append", "replace", "max", "min"]);

/** A state field as the PLANNER writes it. `lane` is deliberately absent: the compiler computes it. */
export const SpecStateField = z
  .strictObject({
    type: StateType,
    enumValues: z.array(z.string().min(1)).min(1).optional(),
    reducer: Reducer.optional(),
    untrusted: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && !f.enumValues)
      ctx.addIssue({
        code: "custom",
        path: ["enumValues"],
        message: "enum fields need enumValues",
      });
    if (f.type !== "enum" && f.enumValues)
      ctx.addIssue({
        code: "custom",
        path: ["enumValues"],
        message: "enumValues only on enum fields",
      });
  });
export type SpecStateField = z.infer<typeof SpecStateField>;
/** After compiling: the lane is known. */
export const CompiledStateField = SpecStateField.and(z.object({ lane: Lane }));
export type CompiledStateField = z.infer<typeof CompiledStateField>;

const refByKind: Record<z.infer<typeof NodeKind>, RegExp> = {
  role: /^(researcher|writer|checker|operator)$/,
  tool: /^[a-z][a-z0-9_]*$/,
  function: /^[a-z][a-z0-9_]*$/,
  subgraph: /^[a-z_][a-z0-9_]*@[1-9]\d*$/,
  approval: /^archie$/,
  fanout: /^[a-z][a-z0-9_]{0,39}$/, // the child node id
  join: /^[a-z][a-z0-9_]{0,39}$/, // the fan-out node id it closes
  condition: /^[a-z][a-z0-9_]{0,39}$/, // the state key it reads
  wait: /^(sleep|event:[a-z][a-z0-9_]*)$/,
};

export const GraphNode = z
  .strictObject({
    id: GraphKey,
    kind: NodeKind,
    ref: z.string().min(1).max(80),
    reads: z.array(GraphKey),
    writes: z.array(GraphKey),
    /** Validated against the ref's own schema by the compiler. */
    config: z.record(z.string(), z.unknown()).optional(),
    budget: z.strictObject({
      maxCostGbp: Gbp,
      maxDurationS: z
        .number()
        .int()
        .positive()
        .max(365 * 86_400),
    }),
    retry: z
      .strictObject({
        max: z.number().int().min(0).max(5),
        backoffS: z.number().int().min(0).max(3600),
      })
      .optional(),
  })
  .superRefine((n, ctx) => {
    if (!refByKind[n.kind].test(n.ref))
      ctx.addIssue({
        code: "custom",
        path: ["ref"],
        message: `ref "${n.ref}" isn't valid for a ${n.kind} node`,
      });
    for (const [k, list] of [
      ["reads", n.reads],
      ["writes", n.writes],
    ] as const)
      if (new Set(list).size !== list.length)
        ctx.addIssue({ code: "custom", path: [k], message: `duplicate key in ${k}` });
  });
export type GraphNode = z.infer<typeof GraphNode>;

export const EdgeOp = z.enum(["eq", "neq", "gt", "lt", "in", "exists"]);
export const GraphEdge = z
  .strictObject({
    from: GraphKey,
    to: GraphKey,
    /** Reads a state value only. No edge is ever evaluated by a model. */
    when: z.strictObject({ key: GraphKey, op: EdgeOp, value: z.unknown().optional() }).optional(),
    /** Required on every back-edge (the compiler checks which edges are back-edges). */
    loop: z.strictObject({ maxIterations: z.number().int().min(1).max(10) }).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.when && e.when.op !== "exists" && e.when.value === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["when", "value"],
        message: `op ${e.when.op} needs a value`,
      });
    if (e.when?.op === "in" && !Array.isArray(e.when.value))
      ctx.addIssue({ code: "custom", path: ["when", "value"], message: "op in needs a list" });
  });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const GraphSpec = z
  .strictObject({
    graphId: GraphId,
    version: z.number().int().positive(),
    parentVersion: z.number().int().positive().optional(),
    taskId: z.string().min(1),
    opportunityId: z.string().min(1).optional(),
    /** A seeded idea (brain/ideas/seed-500.csv), when the graph serves one. */
    hypothesisId: z
      .string()
      .regex(/^I\d{3,}$/)
      .optional(),
    goal: z.string().min(5).max(240),
    successMetric: z.strictObject({
      name: z.string().min(1),
      target: z.number().finite(),
      unit: z.string().min(1),
      /** A registered function id. */
      measuredBy: z.string().regex(/^[a-z][a-z0-9_]*$/),
    }),
    stopConditions: z.array(z.string().min(1)).min(1),
    budgetGbp: z.number().finite().positive(),
    deadline: IsoDate.optional(),
    state: z.record(GraphKey, SpecStateField),
    inputs: z.array(GraphKey),
    nodes: z.array(GraphNode).min(1).max(100),
    edges: z.array(GraphEdge),
    entry: GraphKey,
    exits: z.array(GraphKey).min(1),
    planner: z.strictObject({
      model: z.string().min(1),
      promptVersion: z.string().min(1),
      rationale: z.string().min(1).max(2000),
      assumptions: z.array(z.string().min(1)),
    }),
  })
  .superRefine((g, ctx) => {
    const ids = new Set<string>();
    g.nodes.forEach((n, i) => {
      if (ids.has(n.id))
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "id"],
          message: `duplicate node id ${n.id}`,
        });
      ids.add(n.id);
    });
    const need = (id: string, path: (string | number)[]) => {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path, message: `unknown node ${id}` });
    };
    need(g.entry, ["entry"]);
    g.exits.forEach((x, i) => {
      need(x, ["exits", i]);
    });
    g.edges.forEach((e, i) => {
      need(e.from, ["edges", i, "from"]);
      need(e.to, ["edges", i, "to"]);
      if (e.when && !(e.when.key in g.state))
        ctx.addIssue({
          code: "custom",
          path: ["edges", i, "when", "key"],
          message: `unknown state key ${e.when.key}`,
        });
    });
    g.inputs.forEach((k, i) => {
      if (!(k in g.state))
        ctx.addIssue({ code: "custom", path: ["inputs", i], message: `unknown state key ${k}` });
    });
    g.nodes.forEach((n, i) => {
      for (const k of [...n.reads, ...n.writes])
        if (!(k in g.state))
          ctx.addIssue({
            code: "custom",
            path: ["nodes", i],
            message: `node ${n.id} uses undeclared state key ${k}`,
          });
    });
    if (g.parentVersion !== undefined && g.parentVersion >= g.version)
      ctx.addIssue({
        code: "custom",
        path: ["parentVersion"],
        message: "parentVersion must be older",
      });
  });
export type GraphSpec = z.infer<typeof GraphSpec>;

export const CompileError = z.object({
  rule: z.string().min(1),
  nodeId: z.string().nullable(),
  message: z.string().min(1),
});
export type CompileError = z.infer<typeof CompileError>;

export const CompiledGraph = z.object({
  spec: GraphSpec,
  contentHash: Sha256Hex,
  registryVersion: z.string().min(1),
  lane: Lane,
  stateLanes: z.record(GraphKey, Lane),
  worstCaseCostGbp: Gbp,
  worstCaseSteps: z.number().int().nonnegative(),
  approvalPoints: z.array(GraphKey),
  autonomy: Autonomy,
  shapeFingerprint: Sha256Hex,
  plan: z.object({ order: z.array(GraphKey), layers: z.array(z.array(GraphKey)) }),
});
export type CompiledGraph = z.infer<typeof CompiledGraph>;

export const SANDBOX_NOTE = "Sandbox proves mechanics and cost, not demand.";

export const NodeRunStatus = z.enum([
  "pending",
  "running",
  "waiting",
  "done",
  "failed",
  "skipped",
  "paused",
]);
export const SandboxReport = z.object({
  graphId: GraphId,
  version: z.number().int().positive(),
  attempt: z.number().int().min(1).max(3),
  asOf: IsoDateOrDateTime,
  scenario: z.string().min(1),
  mode: z.enum(["sandbox", "probe"]),
  /** "fake" until the Anthropic key is saved and MODEL_LIVE is on. */
  model: z.enum(["real", "fake"]),
  pass: z.boolean(),
  nodes: z.array(
    z.object({
      nodeId: GraphKey,
      iteration: z.number().int().nonnegative(),
      status: NodeRunStatus,
      costGbp: Gbp,
      durationMs: z.number().int().nonnegative(),
      checks: z.array(
        z.object({ name: z.string(), pass: z.boolean(), detail: z.string().nullable() }),
      ),
      outputRefs: z.array(z.string()),
    }),
  ),
  totals: z.object({
    sandboxCostGbp: Gbp,
    projectedLiveCostGbp: Gbp,
    expectedValueGbp: z.number().finite().nullable(),
  }),
  failures: z.array(z.string()),
  guardrailHits: z.array(CompileError),
  runId: RunId,
  note: z.literal(SANDBOX_NOTE),
});
export type SandboxReport = z.infer<typeof SandboxReport>;

export const GraphRunMode = z.enum(["live", "sandbox", "probe"]);
export const GraphRunStatus = z.enum([
  "pending",
  "running",
  "waiting",
  "paused",
  "done",
  "failed",
  "killed",
]);
export const GraphRun = z.object({
  runId: RunId,
  graphId: GraphId,
  version: z.number().int().positive(),
  instanceId: z.string().nullable(),
  mode: GraphRunMode,
  status: GraphRunStatus,
  nodes: z.array(
    z.object({
      nodeId: GraphKey,
      iteration: z.number().int().nonnegative(),
      status: NodeRunStatus,
    }),
  ),
  costSoFarGbp: Gbp,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  outcomeId: z.string().nullable(),
});
export type GraphRun = z.infer<typeof GraphRun>;

/** The approval record, extended for graphs (written only through the one decisions path). */
export const GraphApproval = z.object({
  task_id: z.string().min(1),
  step_id: z.string().min(1),
  decision: z.enum(["approve", "edit", "reject"]),
  edited_text: z.string().nullable(),
  decided_at: IsoDateTime,
  graph_id: GraphId.nullable(),
  graph_version: z.number().int().positive().nullable(),
  node_id: GraphKey.nullable(),
  comment: z.string().nullable(),
});
export type GraphApproval = z.infer<typeof GraphApproval>;

/** Graph event names for Cloudflare Workflows: [A-Za-z0-9_-] only, at most 100 characters. */
export const graphEventType = (
  kind: "ga" | "gd",
  runId: string,
  nodeId: string,
  iteration: number,
) => {
  const t = `${kind}-${runId}-${nodeId}-${iteration}`;
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(t)) throw new Error(`invalid Workflow event type: ${t}`);
  return t;
};

// ---- Money: every penny is an event (append-only ledgers).

export const CostMode = z.enum(["sandbox", "probe", "planner", "live"]);
export type CostMode = z.infer<typeof CostMode>;
export const CostCategory = z.enum(["model", "tool", "infra", "third_party"]);
export const CostEvent = z.object({
  event_id: z.string().min(1),
  at: IsoDateTime,
  run_id: z.string().nullable(),
  graph_id: z.string().nullable(),
  graph_version: z.number().int().positive().nullable(),
  node_id: z.string().nullable(),
  task_id: z.string().nullable(),
  opportunity_id: z.string().nullable(),
  revenue_path: z.string().nullable(),
  shape_fingerprint: z.string().nullable(),
  mode: CostMode,
  category: CostCategory,
  /** e.g. input_tokens, output_tokens, cache_read_tokens, call, step, row_written, adjustment */
  unit: z.string().min(1),
  quantity: z.number().finite().nonnegative(),
  unit_price_gbp: z.number().finite().nonnegative(),
  /** Negative only for an "adjustment" (reconciliation against the real bill). */
  amount_gbp: z.number().finite(),
  price_table_version: z.string().min(1),
  synthetic: z.boolean(),
  /** True when the cost wasn't actually incurred (a simulated paid action). Never counts as live spend. */
  dry_run: z.boolean(),
  /** Copied from the task so per-playbook caps need no join. Null for unattributed calls. */
  playbook: z.string().nullable().default(null),
  step_id: z.string().nullable().default(null),
});
export type CostEvent = z.infer<typeof CostEvent>;

export const RevenueEvent = z.object({
  event_id: z.string().min(1),
  at: IsoDateTime,
  run_id: z.string().nullable(),
  task_id: z.string().nullable(),
  opportunity_id: z.string().nullable(),
  revenue_path: z.string().min(1),
  rail: z.enum(["stripe", "x402"]),
  reference: z.string().min(1),
  /** Refunds are negative. Only settled money is ever recorded. */
  amount_gbp: z.number().finite(),
  settled_at: IsoDateTime,
  test_mode: z.boolean(),
});
export type RevenueEvent = z.infer<typeof RevenueEvent>;

export const PoolEvent = z.object({
  event_id: z.string().min(1),
  at: IsoDateTime,
  kind: z.enum(["topup", "adjustment"]),
  amount_gbp: z.number().finite(),
  /** A top-up is recorded through the owner-approvals path. */
  approval_id: z.string().nullable(),
  by: z.string().min(1),
  note: z.string().nullable(),
});
export type PoolEvent = z.infer<typeof PoolEvent>;

/**
 * Archie's reasons when rejecting, editing or questioning a plan or an idea (addition 1, 2026-11-18).
 * The planner reads these when revising and its eval reads them; they NEVER enter the outcome ledger
 * (rule 12: Archie's decisions never train scoring).
 */
export const DecisionLogEntry = z.object({
  id: z.string().min(1),
  at: IsoDateTime,
  subject: z.enum(["graph_plan", "graph_node", "idea"]),
  subject_id: z.string().min(1),
  graph_id: z.string().nullable(),
  graph_version: z.number().int().positive().nullable(),
  decision: z.enum(["reject", "edit", "question"]),
  reason: z.string().min(1).max(4000),
  by: z.string().min(1),
  decision_id: z.string().nullable(),
});
export type DecisionLogEntry = z.infer<typeof DecisionLogEntry>;

export { Role as GraphRole };
