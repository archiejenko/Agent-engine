import type { GraphSpec } from "@ae/contracts";
import type { DecisionOption, GraphSpecRow, Storage } from "@ae/storage";

/**
 * Task graph G4: plans for approved ideas. The planner (apps/agent-runner/src/planner.ts) writes graph
 * specs; this module holds what the API and the decisions path need, with storage only:
 *   - plan status for the Ideas feed,
 *   - the diff against the previous attempt (for the approval card),
 *   - applying Archie's approve / edit / reject.
 * Archie's edit comments and reject reasons go to the decision log (the planner reads them when it
 * revises, and in its eval), never the outcome ledger.
 */
export const MAX_PLAN_ATTEMPTS = 3;

export const planGraphId = (cardId: string) => `plan-${cardId.replace(/^card-/, "")}`.slice(0, 64);
export const planRef = (graphId: string, version: number) => `graph:${graphId}@${version}`;
export function parsePlanRef(ref: string) {
  const m = /^graph:(.+)@(\d+)$/.exec(ref);
  if (!m) throw new Error(`not a plan ref: ${ref}`);
  return { graph_id: m[1] as string, version: Number(m[2]) };
}

/** Plan status as the Ideas feed shows it. */
export async function planStatusFor(storage: Storage, cardId: string): Promise<string> {
  const specs = await storage.graphSpecs.versions(planGraphId(cardId));
  const last = specs.at(-1);
  if (!last) return "not planned yet";
  const n = specs.length;
  switch (last.status) {
    case "drafting":
      return `drafting (attempt ${n} of ${MAX_PLAN_ATTEMPTS})`;
    case "probing":
      return `probing (attempt ${n} of ${MAX_PLAN_ATTEMPTS})`;
    case "sandboxing":
      return `sandboxing (attempt ${n} of ${MAX_PLAN_ATTEMPTS})`;
    case "superseded":
      return n >= MAX_PLAN_ATTEMPTS
        ? "couldn't plan"
        : `revising (attempt ${n} of ${MAX_PLAN_ATTEMPTS} used)`;
    case "ready":
      return "ready for you";
    case "couldnt_plan":
      return "couldn't plan";
    default:
      return last.status;
  }
}

/** What changed between two attempts: nodes, edges, budget and goal. */
export function planDiff(prev: GraphSpec | null, next: GraphSpec) {
  if (!prev)
    return {
      first: true,
      nodes_added: [],
      nodes_removed: [],
      nodes_changed: [],
      edges_added: [],
      edges_removed: [],
      budget: null,
    };
  const byId = (s: GraphSpec) => new Map(s.nodes.map((n) => [n.id, n]));
  const a = byId(prev);
  const b = byId(next);
  const edge = (e: GraphSpec["edges"][number]) =>
    `${e.from}→${e.to}${e.when ? ` [${e.when.key} ${e.when.op} ${String(e.when.value ?? "")}]` : ""}`;
  const ea = new Set(prev.edges.map(edge));
  const eb = new Set(next.edges.map(edge));
  return {
    first: false,
    nodes_added: [...b.keys()].filter((k) => !a.has(k)),
    nodes_removed: [...a.keys()].filter((k) => !b.has(k)),
    nodes_changed: [...b.keys()].filter(
      (k) => a.has(k) && JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)),
    ),
    edges_added: [...eb].filter((e) => !ea.has(e)),
    edges_removed: [...ea].filter((e) => !eb.has(e)),
    budget: prev.budgetGbp === next.budgetGbp ? null : { from: prev.budgetGbp, to: next.budgetGbp },
  };
}

export const PLAN_OPTIONS: DecisionOption[] = [
  {
    key: "approve",
    label: "Approve",
    effect: "Run this graph (dry-run until live sends are switched on)",
  },
  {
    key: "edit",
    label: "Edit",
    effect: "Your comment goes back to the planner and uses an attempt",
  },
  // Last = the safe default: nothing runs.
  { key: "reject", label: "Reject", effect: "Drop this plan; your reason is kept for the planner" },
];

/** Opens the approval decision for a ready plan. */
export async function openPlanDecision(
  storage: Storage,
  row: GraphSpecRow,
  evGbp: number,
  now = new Date(),
) {
  await storage.decisions.open({
    type: "graph_plan",
    source_ref: planRef(row.graph_id, row.version),
    summary: `Plan v${row.version} for ${row.opportunity_id ?? row.graph_id}`,
    money_at_stake_gbp: evGbp,
    money_kind: "estimated",
    options: PLAN_OPTIONS,
    recommended: "approve",
    safe_default: "reject",
    deadline: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    context: { graph_id: row.graph_id, version: row.version, card_id: row.opportunity_id },
    synthetic: row.synthetic,
  });
}

/** Archie's decision on a plan. Edit and reject reasons go to the decision log, never the ledger. */
export async function applyGraphPlanOption(
  storage: Storage,
  ref: string,
  option: string,
  o: { by: string; text: string | null; defaulted: boolean; decisionId: string; now?: Date },
) {
  const { graph_id, version } = parsePlanRef(ref);
  const row = await storage.graphSpecs.get(graph_id, version);
  if (!row) throw new Error("no such plan");
  if (option === "approve" && !o.defaulted) {
    await storage.graphSpecs.setStatus(graph_id, version, "approved");
    return;
  }
  const text = (o.text ?? "").trim();
  if (option === "edit" && !text) throw new Error("an edit needs your comment");
  if (!o.defaulted)
    await storage.decisionLog.add({
      id: crypto.randomUUID(),
      at: (o.now ?? new Date()).toISOString(),
      subject: "graph_plan",
      subject_id: graph_id,
      graph_id,
      graph_version: version,
      decision: option === "edit" ? "edit" : "reject",
      reason: text || "no reason given",
      by: o.by,
      decision_id: o.decisionId,
    });
  // Edit: the planner revises on its next pass (a new version, using an attempt). Reject: the plan stops.
  await storage.graphSpecs.setStatus(
    graph_id,
    version,
    option === "edit" ? "superseded" : "rejected",
  );
}
