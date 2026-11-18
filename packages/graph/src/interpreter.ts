import type { CompiledGraph, GraphEdge, GraphNode } from "@ae/contracts";

/**
 * The ONE interpreter (graph plan, G1). It walks any compiled graph; nothing is generated per graph.
 * Bindings decide what a node kind does: the legacy step code (G1 equivalence), Workflows steps (G2),
 * fakes (sandbox, G3). Semantics:
 * - a node gets ONLY the state keys it declares, and may write ONLY the keys it declares;
 * - a node's outgoing edges are either all conditional (the FIRST that matches is taken; a back-edge
 *   whose loop is used up is skipped) or all unconditional (all fire);
 * - nodes run in the compiler's topological order; a back-edge sends the run back to its target;
 * - an approval or wait returns "waiting": the run stops and resumes later with the outcome;
 * - a rejected approval ends the run; a node with no matching edge that isn't an exit ends it "stopped".
 */
export type NodeOutcome =
  | { status: "done"; writes: Record<string, unknown>; costGbp?: number }
  | { status: "waiting"; item?: unknown; kind?: string }
  | { status: "rejected"; reason?: string };

export interface NodeContext {
  runId: string;
  node: GraphNode;
  iteration: number;
  /** Only the node's declared reads. */
  inputs: Record<string, unknown>;
  compiled: CompiledGraph;
}

export interface Bindings {
  run(ctx: NodeContext): Promise<NodeOutcome>;
  /** Called before every node: caps, kill switches, pool. Throw GraphPausedError to pause. */
  beforeNode?(ctx: NodeContext): Promise<void>;
}

export class GraphGuardError extends Error {}
export class GraphPausedError extends Error {}

export interface RunState {
  runId: string;
  values: Record<string, unknown>;
  active: string[];
  iterations: Record<string, number>;
  loops: Record<string, number>;
  status: "running" | "waiting" | "done" | "rejected" | "stopped" | "paused";
  waitingOn: string | null;
  waitingItem?: unknown;
  stoppedAt?: string;
  trace: { nodeId: string; iteration: number; status: string }[];
  costGbp: number;
}

export function newRunState(
  runId: string,
  compiled: CompiledGraph,
  inputs: Record<string, unknown>,
): RunState {
  const values: Record<string, unknown> = {};
  for (const k of compiled.spec.inputs) values[k] = inputs[k] ?? "";
  return {
    runId,
    values,
    active: [compiled.spec.entry],
    iterations: {},
    loops: {},
    status: "running",
    waitingOn: null,
    trace: [],
    costGbp: 0,
  };
}

const matches = (e: GraphEdge, values: Record<string, unknown>) => {
  if (!e.when) return true;
  const v = values[e.when.key];
  const w = e.when.value;
  switch (e.when.op) {
    case "eq":
      return v === w;
    case "neq":
      return v !== w;
    case "gt":
      return typeof v === "number" && typeof w === "number" && v > w;
    case "lt":
      return typeof v === "number" && typeof w === "number" && v < w;
    case "in":
      return Array.isArray(w) && w.includes(v);
    case "exists":
      return v !== undefined && v !== null && v !== "";
  }
};

function reduce(field: { reducer?: string } | undefined, prev: unknown, next: unknown) {
  switch (field?.reducer) {
    case "append":
      return [
        ...(Array.isArray(prev) ? prev : prev === undefined || prev === "" ? [] : [prev]),
        next,
      ];
    case "max":
      return typeof prev === "number" && typeof next === "number" ? Math.max(prev, next) : next;
    case "min":
      return typeof prev === "number" && typeof next === "number" ? Math.min(prev, next) : next;
    default:
      return next;
  }
}

/**
 * Runs (or resumes) a graph until it finishes, waits or stops. `resume` supplies the outcome of the node
 * the run was waiting on.
 */
export async function runGraph(
  compiled: CompiledGraph,
  bindings: Bindings,
  state: RunState,
  resume?: { nodeId: string; outcome: NodeOutcome },
): Promise<RunState> {
  const spec = compiled.spec;
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const pos = new Map(compiled.plan.order.map((id, i) => [id, i]));
  const children = new Set(spec.nodes.filter((n) => n.kind === "fanout").map((n) => n.ref));

  const inputsFor = (n: GraphNode) => Object.fromEntries(n.reads.map((k) => [k, state.values[k]]));
  const apply = (n: GraphNode, writes: Record<string, unknown>, reduceIt: boolean) => {
    for (const [k, v] of Object.entries(writes)) {
      if (!n.writes.includes(k)) throw new GraphGuardError(`${n.id} wrote undeclared key ${k}`);
      state.values[k] = reduceIt ? reduce(spec.state[k], state.values[k], v) : v;
    }
  };
  const ctxFor = (n: GraphNode, extra: Record<string, unknown> = {}): NodeContext => ({
    runId: state.runId,
    node: n,
    iteration: state.iterations[n.id] ?? 0,
    inputs: { ...inputsFor(n), ...extra },
    compiled,
  });

  const fire = (n: GraphNode) => {
    const outs = spec.edges.map((e, idx) => ({ e, idx })).filter(({ e }) => e.from === n.id);
    if (outs.length === 0) return;
    const conditional = outs.some(({ e }) => e.when);
    const chosen = conditional
      ? outs
          .filter(
            ({ e, idx }) =>
              (!e.loop || (state.loops[idx] ?? 0) < e.loop.maxIterations) &&
              matches(e, state.values),
          )
          .slice(0, 1)
      : outs;
    if (chosen.length === 0 && !spec.exits.includes(n.id)) {
      state.status = "stopped";
      state.stoppedAt = n.id;
      return;
    }
    for (const { e, idx } of chosen) {
      if (e.loop) state.loops[idx] = (state.loops[idx] ?? 0) + 1;
      if (!state.active.includes(e.to)) state.active.push(e.to);
    }
  };

  const finish = (n: GraphNode, status: string) => {
    state.trace.push({ nodeId: n.id, iteration: state.iterations[n.id] ?? 0, status });
    state.iterations[n.id] = (state.iterations[n.id] ?? 0) + 1;
    state.active = state.active.filter((x) => x !== n.id);
  };

  if (resume) {
    if (state.status !== "waiting" || state.waitingOn !== resume.nodeId)
      throw new GraphGuardError(`run isn't waiting on ${resume.nodeId}`);
    const n = byId.get(resume.nodeId) as GraphNode;
    state.status = "running";
    state.waitingOn = null;
    delete state.waitingItem;
    if (resume.outcome.status === "rejected") {
      finish(n, "rejected");
      state.status = "rejected";
      return state;
    }
    if (resume.outcome.status === "done") {
      apply(n, resume.outcome.writes, false);
      state.costGbp += resume.outcome.costGbp ?? 0;
      finish(n, "done");
      fire(n);
    }
  }

  while (state.status === "running") {
    const next = [...state.active].sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0))[0];
    if (next === undefined) {
      state.status = "done";
      break;
    }
    const n = byId.get(next) as GraphNode;
    if (children.has(n.id)) throw new GraphGuardError(`${n.id} only runs inside its fan-out`);
    if (bindings.beforeNode) {
      try {
        await bindings.beforeNode(ctxFor(n));
      } catch (e) {
        if (e instanceof GraphPausedError) {
          state.status = "paused";
          state.stoppedAt = n.id;
          return state;
        }
        throw e;
      }
    }
    if (n.kind === "fanout") {
      const cfg = n.config as { over: string; item_key: string; width: number; max_items: number };
      const child = byId.get(n.ref) as GraphNode;
      const items = (
        Array.isArray(state.values[cfg.over]) ? (state.values[cfg.over] as unknown[]) : []
      ).slice(0, cfg.max_items);
      for (let i = 0; i < items.length; i += cfg.width) {
        const batch = items.slice(i, i + cfg.width);
        const outs = await Promise.all(
          batch.map((item) => bindings.run(ctxFor(child, { [cfg.item_key]: item }))),
        );
        for (const o of outs) {
          if (o.status !== "done")
            throw new GraphGuardError(`fan-out child ${child.id} can't wait or reject`);
          apply(child, o.writes, true);
          state.costGbp += o.costGbp ?? 0;
          state.trace.push({
            nodeId: child.id,
            iteration: state.iterations[child.id] ?? 0,
            status: "done",
          });
          state.iterations[child.id] = (state.iterations[child.id] ?? 0) + 1;
        }
      }
      finish(n, "done");
      fire(n);
      continue;
    }
    if (n.kind === "join" || n.kind === "condition") {
      finish(n, "done");
      fire(n);
      continue;
    }
    const out = await bindings.run(ctxFor(n));
    if (out.status === "waiting") {
      state.status = "waiting";
      state.waitingOn = n.id;
      state.waitingItem = out.item;
      return state;
    }
    if (out.status === "rejected") {
      finish(n, "rejected");
      state.status = "rejected";
      return state;
    }
    apply(n, out.writes, false);
    state.costGbp += out.costGbp ?? 0;
    finish(n, "done");
    fire(n);
  }
  return state;
}
