import type { GraphPolicy } from "@ae/config";
import {
  type Autonomy,
  type CompiledGraph,
  type CompileError,
  type GraphNode,
  GraphSpec,
  type Lane,
} from "@ae/contracts";
import { functionById } from "./functions.ts";
import { canonicalJson, type NodeLibrary, sha256Hex } from "./registry-export.ts";

/**
 * The compiler (graph plan, G1): compile(spec, library, policy, ctx) → { ok, compiled, errors }.
 * Pure and deterministic: no model calls and no I/O beyond the library snapshot it's given. Every rule
 * returns structured errors {rule, nodeId, message}, which the planner receives as they are.
 */
export interface CompileContext {
  /** Lane of the task's input facts: licensed if any is. */
  taskLane: Lane;
  /** The per-task spend cap the budget must stay under. */
  perTaskCapGbp: number;
  /** Autonomy the graph has earned or inherits: a converted playbook's own level, a promoted shape's level. */
  earnedAutonomy?: Autonomy;
}

export interface CompileResult {
  ok: boolean;
  compiled: CompiledGraph | null;
  errors: CompileError[];
}

export const RULES = [
  "schema", // 1
  "references", // 2
  "connectivity", // 3
  "loops", // 4
  "size", // 5
  "state_flow", // 6
  "lane", // 7
  "checker_before_outbound", // 8
  "untrusted", // 9
  "budget", // 10
  "autonomy", // 11
  "outreach", // 12
  "deterministic_edges", // 13
  "reproducible", // 14 (a property: same inputs → same hash; tested, never an error)
  "steps", // 15
  "ids", // 16 (Workflow-safe ids; enforced by the schema)
] as const;
export type Rule = (typeof RULES)[number];

const LEVELS: Autonomy[] = ["L0", "L1", "L2", "L3"];
const minLevel = (a: Autonomy, b: Autonomy) => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b);

interface NodeInfo {
  node: GraphNode;
  tools: string[];
  external: boolean;
  servesCustomer: boolean;
  outreachSend: boolean;
  usesUntrustedTool: boolean;
  cost: number;
}

export async function compile(
  input: unknown,
  lib: NodeLibrary,
  policy: GraphPolicy,
  ctx: CompileContext,
): Promise<CompileResult> {
  const errors: CompileError[] = [];
  const err = (rule: Rule, nodeId: string | null, message: string) =>
    errors.push({ rule, nodeId, message });

  // ---- 1 schema (and 16 ids: node ids and keys are Workflow-safe by schema)
  const parsed = GraphSpec.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const path = i.path.join(".");
      err(
        /id|entry|exits|from|to|reads|writes|state/.test(path) && /lowercase/.test(i.message)
          ? "ids"
          : "schema",
        null,
        `${path}: ${i.message}`,
      );
    }
    return { ok: false, compiled: null, errors };
  }
  const spec = parsed.data;
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const g = policy.guardrails;

  // ---- 2 references (and 4: a graph cannot grant permissions)
  const info = new Map<string, NodeInfo>();
  for (const n of spec.nodes) {
    const i: NodeInfo = {
      node: n,
      tools: [],
      external: false,
      servesCustomer: false,
      outreachSend: false,
      usesUntrustedTool: false,
      cost: n.budget.maxCostGbp,
    };
    const cfg = (n.config ?? {}) as Record<string, unknown>;
    const noConfig = () => {
      if (n.config && Object.keys(n.config).length)
        err("references", n.id, `${n.kind} nodes take no config`);
    };
    switch (n.kind) {
      case "role": {
        if (!lib.roles.some((r) => r.ref === n.ref))
          err("references", n.id, `unknown role ${n.ref}`);
        const extra = Object.keys(cfg).filter((k) => !["playbook", "step", "tools"].includes(k));
        if (extra.length) err("references", n.id, `unknown config keys: ${extra.join(", ")}`);
        if (cfg.playbook !== undefined || cfg.step !== undefined) {
          const pb = lib.subgraphs.find((p) => p.name === cfg.playbook);
          const step = pb?.steps?.find((s) => s.id === cfg.step);
          if (!pb || !step)
            err(
              "references",
              n.id,
              `no step ${String(cfg.step)} in playbook ${String(cfg.playbook)}`,
            );
          else if (!("role" in step) || step.role !== n.ref)
            err("references", n.id, `step ${String(cfg.step)} isn't a ${n.ref} step`);
          else {
            const allowed = step.tools;
            const asked = Array.isArray(cfg.tools) ? (cfg.tools as string[]) : allowed;
            const grant = asked.filter((t) => !allowed.includes(t));
            if (grant.length)
              err(
                "references",
                n.id,
                `asks for tools its step doesn't have: ${grant.join(", ")} (a graph can't grant permissions)`,
              );
            i.tools = asked.filter((t) => allowed.includes(t));
          }
        } else if (cfg.tools !== undefined)
          err("references", n.id, "tools can only narrow a bound playbook step");
        break;
      }
      case "tool": {
        noConfig();
        const t = lib.tools.find((x) => x.ref === n.ref);
        if (!t) err("references", n.id, `unknown tool ${n.ref}`);
        else {
          i.tools = [t.ref];
          i.cost = Math.max(i.cost, t.cost_gbp_per_call);
        }
        break;
      }
      case "function": {
        const f = functionById(n.ref);
        if (!f) {
          err("references", n.id, `unknown function ${n.ref}`);
          break;
        }
        for (const [k, def] of Object.entries(f.config)) {
          if (def.required && cfg[k] === undefined)
            err("references", n.id, `config.${k} is required`);
          if (cfg[k] !== undefined && typeof cfg[k] !== def.type)
            err("references", n.id, `config.${k} must be a ${def.type}`);
        }
        for (const k of Object.keys(cfg))
          if (!(k in f.config)) err("references", n.id, `unknown config key ${k}`);
        i.cost = Math.max(i.cost, f.cost_gbp);
        break;
      }
      case "subgraph": {
        const [name, v] = n.ref.split("@");
        const pb = lib.subgraphs.find((p) => p.name === name && p.version === Number(v));
        if (!pb) err("references", n.id, `no promoted playbook ${n.ref}`);
        else i.tools = (pb.steps ?? []).flatMap((s) => ("tools" in s ? s.tools : []));
        break;
      }
      case "approval": {
        const extra = Object.keys(cfg).filter((k) => !["kind", "playbook", "sample"].includes(k));
        if (extra.length) err("references", n.id, `unknown config keys: ${extra.join(", ")}`);
        break;
      }
      case "fanout": {
        const child = byId.get(n.ref);
        if (!child) err("references", n.id, `fan-out child ${n.ref} isn't a node`);
        if (
          typeof cfg.over !== "string" ||
          !(cfg.over in spec.state) ||
          spec.state[cfg.over]?.type !== "list"
        )
          err("references", n.id, "config.over must name a list state key");
        if (typeof cfg.item_key !== "string" || !(cfg.item_key in spec.state))
          err("references", n.id, "config.item_key must name a state key");
        if (!Number.isInteger(cfg.width) || !Number.isInteger(cfg.max_items))
          err("references", n.id, "config.width and config.max_items are required whole numbers");
        break;
      }
      case "join": {
        noConfig();
        if (byId.get(n.ref)?.kind !== "fanout")
          err("references", n.id, `join must name a fan-out node, not ${n.ref}`);
        break;
      }
      case "condition": {
        noConfig();
        if (!(n.ref in spec.state)) err("references", n.id, `condition reads unknown key ${n.ref}`);
        break;
      }
      case "wait": {
        if (!lib.waits.includes(n.ref)) err("references", n.id, `unknown wait ${n.ref}`);
        const extra = Object.keys(cfg).filter((k) => k !== "seconds");
        if (extra.length) err("references", n.id, `unknown config keys: ${extra.join(", ")}`);
        if (n.ref === "sleep" && !Number.isInteger(cfg.seconds))
          err("references", n.id, "sleep needs config.seconds");
        break;
      }
    }
    for (const t of i.tools) {
      const lt = lib.tools.find((x) => x.ref === t);
      if (!lt) {
        err("references", n.id, `unknown tool ${t}`);
        continue;
      }
      if (lt.acts_externally) i.external = true;
      if (lt.serves_customer) i.servesCustomer = true;
      if (g.outreach_send_tools.includes(t)) i.outreachSend = true;
      if (g.untrusted_output_tools.includes(t)) i.usesUntrustedTool = true;
      const role =
        n.kind === "role" ? n.ref : lt.acts_externally ? "operator" : lt.allowed_roles[0];
      if (n.kind !== "subgraph" && role && !lt.allowed_roles.includes(role))
        err("references", n.id, `${role} may not call ${t} (a graph can't grant permissions)`);
    }
    info.set(n.id, i);
  }
  const metric = functionById(spec.successMetric.measuredBy);
  if (!metric?.metric)
    err(
      "references",
      null,
      `successMetric.measuredBy ${spec.successMetric.measuredBy} isn't a registered metric function`,
    );

  // ---- Graph structure: fan-out children are entered from their fan-out node.
  const succ = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) succ.get(e.from)?.push(e.to);
  const fanChild = new Map<string, string>();
  for (const n of spec.nodes) if (n.kind === "fanout" && byId.has(n.ref)) fanChild.set(n.id, n.ref);
  const childOf = new Map([...fanChild.entries()].map(([f, c]) => [c, f]));
  const next = (id: string) => [
    ...(succ.get(id) ?? []),
    ...(fanChild.has(id) ? [fanChild.get(id) as string] : []),
  ];

  // ---- 3 connectivity
  const reach = (from: string, step: (id: string) => string[]) => {
    const seen = new Set<string>([from]);
    const q = [from];
    while (q.length)
      for (const x of step(q.shift() as string))
        if (!seen.has(x)) {
          seen.add(x);
          q.push(x);
        }
    return seen;
  };
  const fromEntry = reach(spec.entry, next);
  const pred = new Map<string, string[]>(spec.nodes.map((n) => [n.id, []]));
  for (const e of spec.edges) pred.get(e.to)?.push(e.from);
  const canExit = new Set<string>();
  for (const x of spec.exits) for (const y of reach(x, (id) => pred.get(id) ?? [])) canExit.add(y);
  for (const n of spec.nodes) {
    if (!fromEntry.has(n.id)) err("connectivity", n.id, "not reachable from the entry");
    const viaFan = childOf.has(n.id) && canExit.has(childOf.get(n.id) as string);
    if (!canExit.has(n.id) && !viaFan) err("connectivity", n.id, "can't reach an exit");
  }

  // ---- 4 loops: back-edges found by DFS from the entry must carry loop.maxIterations.
  const backEdges = new Set<number>();
  {
    const state = new Map<string, 0 | 1 | 2>();
    const dfs = (id: string) => {
      state.set(id, 1);
      spec.edges.forEach((e, idx) => {
        if (e.from !== id) return;
        const s = state.get(e.to) ?? 0;
        if (s === 1) backEdges.add(idx);
        else if (s === 0) dfs(e.to);
      });
      const c = fanChild.get(id);
      if (c && (state.get(c) ?? 0) === 0) dfs(c);
      state.set(id, 2);
    };
    dfs(spec.entry);
  }
  spec.edges.forEach((e, idx) => {
    if (backEdges.has(idx)) {
      if (!e.loop)
        err(
          "loops",
          e.from,
          `the edge ${e.from} → ${e.to} makes a cycle without loop.maxIterations`,
        );
      else if (e.loop.maxIterations > policy.limits.max_loop_iterations)
        err(
          "loops",
          e.from,
          `loop ${e.from} → ${e.to} allows ${e.loop.maxIterations} iterations (max ${policy.limits.max_loop_iterations})`,
        );
    } else if (e.loop)
      err("loops", e.from, `the edge ${e.from} → ${e.to} isn't a back-edge but carries a loop`);
  });
  const forward = spec.edges.filter((_, idx) => !backEdges.has(idx));
  const fsucc = (id: string) => [
    ...forward.filter((e) => e.from === id).map((e) => e.to),
    ...(fanChild.has(id) ? [fanChild.get(id) as string] : []),
  ];
  const fpred = (id: string) => [
    ...forward.filter((e) => e.to === id).map((e) => e.from),
    ...(childOf.has(id) ? [childOf.get(id) as string] : []),
  ];

  // Topological order of the forward graph (ties broken by spec order).
  const order: string[] = [];
  {
    const indeg = new Map(spec.nodes.map((n) => [n.id, fpred(n.id).length]));
    const ready = spec.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
    while (ready.length) {
      ready.sort(
        (a, b) => spec.nodes.findIndex((n) => n.id === a) - spec.nodes.findIndex((n) => n.id === b),
      );
      const id = ready.shift() as string;
      order.push(id);
      for (const s of fsucc(id)) {
        indeg.set(s, (indeg.get(s) as number) - 1);
        if (indeg.get(s) === 0) ready.push(s);
      }
    }
    if (order.length !== spec.nodes.length)
      err("loops", null, "the graph has a cycle that isn't a declared loop");
  }
  if (
    errors.some((e) => e.rule === "loops" || e.rule === "connectivity" || e.rule === "references")
  )
    return { ok: false, compiled: null, errors };

  // Depth (longest forward path, in nodes) and layers.
  const depth = new Map<string, number>();
  for (const id of order)
    depth.set(id, Math.max(1, ...fpred(id).map((p) => (depth.get(p) ?? 0) + 1)));
  const layers: string[][] = [];
  for (const id of order) {
    const d = (depth.get(id) as number) - 1;
    layers[d] = [...(layers[d] ?? []), id];
  }

  // ---- 5 size
  if (spec.nodes.length > policy.limits.max_nodes)
    err("size", null, `${spec.nodes.length} nodes (max ${policy.limits.max_nodes})`);
  if (layers.length > policy.limits.max_depth)
    err("size", null, `depth ${layers.length} (max ${policy.limits.max_depth})`);
  for (const n of spec.nodes)
    if (n.kind === "fanout") {
      const c = n.config as { width: number; max_items: number };
      if (c.width > policy.limits.max_fanout_width)
        err("size", n.id, `fan-out width ${c.width} (max ${policy.limits.max_fanout_width})`);
      if (c.max_items > policy.limits.max_fanout_items)
        err("size", n.id, `fan-out items ${c.max_items} (max ${policy.limits.max_fanout_items})`);
    }

  // ---- 6 state flow: every read is written upstream on EVERY path (or is an input).
  const availIn = new Map<string, Set<string>>();
  for (const id of order) {
    const n = byId.get(id) as GraphNode;
    const ps = fpred(id);
    let avail: Set<string>;
    if (id === spec.entry || ps.length === 0) avail = new Set(spec.inputs);
    else {
      const sets = ps.map((p) => {
        const s = new Set(availIn.get(p));
        if (childOf.get(id) !== p) for (const w of (byId.get(p) as GraphNode).writes) s.add(w);
        return s;
      });
      avail = new Set([...(sets[0] ?? [])].filter((k) => sets.every((s) => s.has(k))));
    }
    if (childOf.has(id))
      avail.add(
        ((byId.get(childOf.get(id) as string) as GraphNode).config as { item_key: string })
          .item_key,
      );
    availIn.set(id, avail);
    for (const k of n.reads)
      if (!avail.has(k)) err("state_flow", id, `reads ${k} before it is written on every path`);
  }
  // Keys written by parallel branches need a reducer.
  const fReach = new Map(spec.nodes.map((n) => [n.id, reach(n.id, fsucc)]));
  const ordered = (a: string, b: string) => fReach.get(a)?.has(b) || fReach.get(b)?.has(a);
  const condBranches = spec.nodes
    .map((n) => ({ id: n.id, outs: forward.filter((e) => e.from === n.id && e.when) }))
    .filter((c) => c.outs.length >= 2);
  const exclusive = (a: string, b: string) =>
    condBranches.some((c) => {
      const ia = c.outs.map((e, i) => (fReach.get(e.to)?.has(a) ? i : -1)).filter((i) => i >= 0);
      const ib = c.outs.map((e, i) => (fReach.get(e.to)?.has(b) ? i : -1)).filter((i) => i >= 0);
      return ia.length > 0 && ib.length > 0 && ia.every((i) => !ib.includes(i));
    });
  const writers = new Map<string, string[]>();
  for (const n of spec.nodes)
    for (const w of n.writes) writers.set(w, [...(writers.get(w) ?? []), n.id]);
  for (const [k, ws] of writers) {
    const field = spec.state[k];
    if (field?.reducer) continue;
    if (ws.some((w) => childOf.has(w)))
      err(
        "state_flow",
        ws.find((w) => childOf.has(w)) ?? null,
        `${k} is written once per fan-out item and needs a reducer`,
      );
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i] as string;
        const b = ws[j] as string;
        if (!ordered(a, b) && !exclusive(a, b))
          err(
            "state_flow",
            b,
            `${k} is written by parallel branches (${a}, ${b}) and needs a reducer`,
          );
      }
  }

  // ---- 9 untrusted: which keys can hold fetched content.
  const untrusted = new Set(
    Object.entries(spec.state)
      .filter(([, f]) => f.untrusted)
      .map(([k]) => k),
  );
  for (const id of order) {
    const n = byId.get(id) as GraphNode;
    const i = info.get(id) as NodeInfo;
    const launders = n.kind === "role" && (n.ref === "writer" || n.ref === "checker");
    const taints =
      (n.kind === "tool" && i.usesUntrustedTool) ||
      (!launders && (i.usesUntrustedTool || n.reads.some((k) => untrusted.has(k))));
    if (taints) for (const w of n.writes) if (!(n.kind === "approval")) untrusted.add(w);
  }
  for (const n of spec.nodes) {
    const i = info.get(n.id) as NodeInfo;
    const isOperator = n.kind === "role" && n.ref === "operator";
    if (isOperator || i.external)
      for (const k of n.reads)
        if (untrusted.has(k))
          err(
            "untrusted",
            n.id,
            `${isOperator ? "an operator" : "an externally acting node"} reads untrusted ${k}; pass it through a writer and a checker first`,
          );
  }

  // ---- 7 licence lane
  const lane: Lane = ctx.taskLane;
  const stateLanes: Record<string, Lane> = Object.fromEntries(
    Object.keys(spec.state).map((k) => [k, lane]),
  );
  for (const n of spec.nodes) {
    const i = info.get(n.id) as NodeInfo;
    if (lane === "licensed" && (i.external || i.servesCustomer))
      err("lane", n.id, "a licensed graph can't act externally or serve a customer");
    for (const t of i.tools) {
      const lt = lib.tools.find((x) => x.ref === t);
      if (lt && !lt.allowed_lanes.includes(lane))
        err("lane", n.id, `${t} isn't allowed in the ${lane} lane`);
    }
  }

  // ---- 8 checker before outbound: content written by a writer is checked before it's sent.
  const contentKeys = new Set(
    spec.nodes.filter((n) => n.kind === "role" && n.ref === "writer").flatMap((n) => n.writes),
  );
  const checkedIn = new Map<string, Set<string>>();
  const checkedOut = (id: string) => {
    const n = byId.get(id) as GraphNode;
    const s = new Set(checkedIn.get(id));
    if (n.kind !== "approval") for (const w of n.writes) s.delete(w);
    if (n.kind === "role" && n.ref === "checker") for (const r of n.reads) s.add(r);
    return s;
  };
  for (const id of order) {
    const ps = fpred(id);
    const sets = ps.map((p) => checkedOut(p));
    checkedIn.set(
      id,
      ps.length
        ? new Set([...(sets[0] ?? [])].filter((k) => sets.every((s) => s.has(k))))
        : new Set(),
    );
  }
  for (const n of spec.nodes) {
    if (!(info.get(n.id) as NodeInfo).external) continue;
    for (const k of n.reads)
      if (contentKeys.has(k) && !checkedIn.get(n.id)?.has(k))
        err(
          "checker_before_outbound",
          n.id,
          `sends ${k} without a checker reading it on every path`,
        );
  }

  // ---- 12 outreach: suppression and cooldown on every path into an outreach send.
  const fnSeen = new Map<string, Set<string>>();
  for (const id of order) {
    const ps = fpred(id);
    const outs = ps.map((p) => {
      const s = new Set(fnSeen.get(p));
      const pn = byId.get(p) as GraphNode;
      if (pn.kind === "function") s.add(pn.ref);
      return s;
    });
    fnSeen.set(
      id,
      ps.length
        ? new Set([...(outs[0] ?? [])].filter((k) => outs.every((s) => s.has(k))))
        : new Set(),
    );
  }
  for (const n of spec.nodes) {
    if (!(info.get(n.id) as NodeInfo).outreachSend) continue;
    for (const fn of ["suppression_check", "contact_cooldown"])
      if (!fnSeen.get(n.id)?.has(fn))
        err("outreach", n.id, `an outreach send without ${fn} on every path`);
  }

  // ---- 13 deterministic edges: edges branch on typed state only; no mixing.
  const deterministicWriters = new Set(["function", "tool", "condition"]);
  const typedOk = (k: string) => {
    const f = spec.state[k];
    if (!f) return false;
    if (["enum", "boolean", "number"].includes(f.type)) return true;
    const ws = writers.get(k) ?? [];
    return (
      ws.every((w) => deterministicWriters.has((byId.get(w) as GraphNode).kind)) ||
      spec.inputs.includes(k)
    );
  };
  for (const n of spec.nodes) {
    const outs = spec.edges.filter((e) => e.from === n.id);
    const cond = outs.filter((e) => e.when);
    if (cond.length && cond.length !== outs.length)
      err("deterministic_edges", n.id, "mixes conditional and unconditional outgoing edges");
    for (const e of cond)
      if (!typedOk((e.when as { key: string }).key))
        err(
          "deterministic_edges",
          n.id,
          `branches on ${e.when?.key}, a free-text value a model wrote; have a role write a typed enum key instead`,
        );
    if (n.kind === "condition" && !typedOk(n.ref))
      err("deterministic_edges", n.id, `condition reads ${n.ref}, a free-text value a model wrote`);
  }

  // ---- 10 budget and 15 steps: worst case counts retries, loop iterations and fan-out items.
  const mult = new Map(spec.nodes.map((n) => [n.id, 1 + (n.retry?.max ?? 0)]));
  spec.edges.forEach((e, idx) => {
    if (!backEdges.has(idx) || !e.loop) return;
    const body = [...(fReach.get(e.to) ?? [])].filter(
      (x) => fReach.get(x)?.has(e.from) || x === e.from,
    );
    for (const x of body) mult.set(x, (mult.get(x) as number) * (1 + e.loop.maxIterations));
  });
  for (const [f, c] of fanChild) {
    const items = ((byId.get(f) as GraphNode).config as { max_items: number }).max_items;
    for (const x of reach(c, fsucc)) mult.set(x, (mult.get(x) as number) * items);
  }
  let worstCase = 0;
  let worstSteps = 0;
  for (const n of spec.nodes) {
    worstCase += (mult.get(n.id) as number) * (info.get(n.id) as NodeInfo).cost;
    worstSteps += (mult.get(n.id) as number) * policy.limits.steps_per_node;
  }
  worstCase = Math.round(worstCase * 1e9) / 1e9;
  if (worstCase > spec.budgetGbp + 1e-9)
    err(
      "budget",
      null,
      `worst-case cost £${worstCase.toFixed(4)} is over the budget £${spec.budgetGbp.toFixed(4)}`,
    );
  if (spec.budgetGbp > ctx.perTaskCapGbp + 1e-9)
    err(
      "budget",
      null,
      `budget £${spec.budgetGbp.toFixed(2)} is over the per-task cap £${ctx.perTaskCapGbp.toFixed(2)}`,
    );
  if (worstSteps > policy.limits.max_workflow_steps)
    err(
      "steps",
      null,
      `worst case ${worstSteps} Workflow steps (max ${policy.limits.max_workflow_steps})`,
    );

  // ---- 11 autonomy: earned (converted playbook or promoted shape), else bespoke ≤ policy max.
  const subLevels = spec.nodes
    .filter((n) => n.kind === "subgraph")
    .map((n) => {
      const [name, v] = n.ref.split("@");
      return (
        lib.subgraphs.find((p) => p.name === name && p.version === Number(v))?.autonomy ?? "L0"
      );
    });
  const composedOnly =
    spec.nodes.every((n) => ["subgraph", "approval", "function", "condition"].includes(n.kind)) &&
    subLevels.length > 0;
  let autonomy: Autonomy = ctx.earnedAutonomy ?? policy.autonomy.bespoke_max;
  if (!ctx.earnedAutonomy)
    autonomy = composedOnly
      ? subLevels.reduce(minLevel)
      : minLevel(autonomy, policy.autonomy.bespoke_max);
  const approvedIn = new Map<string, boolean>();
  for (const id of order) {
    const ps = fpred(id);
    const outs = ps.map((p) => {
      const pn = byId.get(p) as GraphNode;
      if (pn.kind === "approval") return true;
      if (pn.kind === "function" || pn.kind === "condition" || pn.kind === "join")
        return approvedIn.get(p) as boolean;
      return false;
    });
    approvedIn.set(id, ps.length > 0 && outs.every(Boolean));
  }
  for (const n of spec.nodes) {
    if (!(info.get(n.id) as NodeInfo).external) continue;
    if (autonomy === "L0")
      err("autonomy", n.id, "an L0 graph can't contain an externally acting node");
    else if (autonomy === "L1" && !approvedIn.get(n.id))
      err(
        "autonomy",
        n.id,
        "at L1 an approval must come right before every externally acting node (only deterministic checks between)",
      );
  }

  if (errors.length) return { ok: false, compiled: null, errors };

  // ---- 14 reproducible: the same spec, library and policy always give the same hash.
  const policyHash = await sha256Hex(canonicalJson(policy));
  const contentHash = await sha256Hex(
    canonicalJson({ spec, registryVersion: lib.registryVersion, policyHash }),
  );
  const compiled: CompiledGraph = {
    spec,
    contentHash,
    registryVersion: lib.registryVersion,
    lane,
    stateLanes,
    worstCaseCostGbp: worstCase,
    worstCaseSteps: worstSteps,
    approvalPoints: spec.nodes.filter((n) => n.kind === "approval").map((n) => n.id),
    autonomy,
    shapeFingerprint: await shapeFingerprint(spec),
    plan: { order, layers },
  };
  return { ok: true, compiled, errors: [] };
}

/**
 * A graph's SHAPE: node ids, kinds, refs and step bindings, and edges (with their branch keys and loop
 * bounds). Per-task values (target company, budgets, goal text, edge comparison values) are ignored, so
 * the same route for two companies has one fingerprint.
 */
export async function shapeFingerprint(spec: GraphSpec): Promise<string> {
  const shape = {
    nodes: [...spec.nodes]
      .map((n) => ({
        id: n.id,
        kind: n.kind,
        ref: n.ref,
        bind:
          n.kind === "role"
            ? { playbook: n.config?.playbook ?? null, step: n.config?.step ?? null }
            : null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...spec.edges]
      .map((e) => ({
        from: e.from,
        to: e.to,
        key: e.when?.key ?? null,
        op: e.when?.op ?? null,
        loop: e.loop?.maxIterations ?? null,
      }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    entry: spec.entry,
    exits: [...spec.exits].sort(),
  };
  return sha256Hex(canonicalJson(shape));
}
