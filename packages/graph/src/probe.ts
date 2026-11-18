import type { GraphPolicy } from "@ae/config";
import type { CompileError, GraphSpec } from "@ae/contracts";
import type { NodeLibrary } from "./registry-export.ts";

/**
 * Probes (graph plan G3): a small, read-only graph the planner may ask the sandbox to run so it can learn
 * something before it plans (for example, whether a company has the facts a draft would need). A probe
 * may have at most `probe_max_nodes` nodes, no operator, no approval or wait, and no node that can act
 * externally, directly or through a tool its role's step lists. Its cost counts against the graph's
 * sandbox cap. Returns every problem found; an empty list means the probe may run.
 */
export function checkProbe(spec: GraphSpec, lib: NodeLibrary, policy: GraphPolicy): CompileError[] {
  const errors: CompileError[] = [];
  const err = (nodeId: string | null, message: string) =>
    errors.push({ rule: "probe", nodeId, message });
  const max = policy.sandbox.probe_max_nodes;
  if (spec.nodes.length > max)
    err(null, `a probe has at most ${max} nodes (this one has ${spec.nodes.length})`);
  const external = new Set(lib.tools.filter((t) => t.acts_externally).map((t) => t.ref));
  for (const n of spec.nodes) {
    if (n.kind === "approval" || n.kind === "wait")
      err(n.id, `a probe can't ${n.kind === "approval" ? "ask for approval" : "wait"}`);
    if (n.kind === "subgraph" || n.kind === "fanout")
      err(n.id, `a probe can't contain a ${n.kind} node`);
    if (n.kind === "tool" && external.has(n.ref))
      err(n.id, `${n.ref} acts externally; a probe is read-only`);
    if (n.kind === "role") {
      if (n.ref === "operator") err(n.id, "a probe has no operator");
      const cfg = (n.config ?? {}) as { playbook?: string; step?: string; tools?: string[] };
      const steps = (lib.subgraphs.find((s) => s.name === cfg.playbook)?.steps ?? []) as {
        id?: string;
        tools?: string[];
      }[];
      const step = steps.find((s) => s.id === cfg.step);
      for (const t of cfg.tools ?? step?.tools ?? [])
        if (external.has(t)) err(n.id, `its step can call ${t}, which acts externally`);
    }
  }
  return errors;
}

/** Why another sandbox attempt or probe for this graph may not start, or null. */
export function sandboxCapReason(
  spentGbp: number,
  nextWorstCaseGbp: number,
  policy: GraphPolicy,
): string | null {
  const cap = policy.sandbox.max_cost_per_graph_gbp;
  if (spentGbp + nextWorstCaseGbp > cap + 1e-9)
    return `the graph's sandbox cap (£${cap.toFixed(2)}, including probes) would be exceeded: £${spentGbp.toFixed(4)} spent`;
  return null;
}
