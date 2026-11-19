import type { GraphSpec } from "@ae/contracts";
import type { PlannerInput } from "./planner.ts";

// ---- The deterministic stand-in planner (until the real model is switched on)

/**
 * Reuses the named playbook's converted graph. On a first attempt it over-asks on budget (as a real
 * model might), then fits node budgets to the cap the compiler reports. If an idea has no verified facts
 * it asks for one probe first. It never reads anything but its structured input.
 */
export function fakePlanner(req: { user: string }): string {
  const input = JSON.parse(req.user) as PlannerInput;
  const pb = input.idea.playbooks[0] as string;
  const base = input.catalogue.find((c) => c.playbook === pb)?.graph as GraphSpec | undefined;
  if (!base)
    return JSON.stringify({
      action: "submit_graph",
      spec: {},
      rationale: `no graph for ${pb}`,
      assumptions: [],
    });
  if (
    input.idea.fact_refs.length === 0 &&
    input.probe_reports.length === 0 &&
    input.probes_left > 0
  ) {
    const first = base.nodes.find((n) => n.kind === "role" && n.ref === "researcher");
    if (first)
      return JSON.stringify({
        action: "request_probe",
        question: "Is there enough verified data to research this company?",
        spec: {
          goal: "Check the research step has data to work with.",
          successMetric: { name: "brief", target: 1, unit: "briefs", measuredBy: "count_replies" },
          stopConditions: ["one brief"],
          budgetGbp: Math.max(first.budget.maxCostGbp, 0.01),
          state: Object.fromEntries(
            Object.entries(base.state).filter(([k]) =>
              [...first.reads, ...first.writes].includes(k),
            ),
          ),
          inputs: base.inputs.filter((k) => first.reads.includes(k)),
          nodes: [first],
          edges: [],
          entry: first.id,
          exits: [first.id],
        },
      });
  }
  const budget = input.suggested_budget_gbp;
  const overAsk = input.attempt === 1 && !input.previous;
  const total = base.nodes.reduce((a, n) => a + n.budget.maxCostGbp, 0);
  const scale = total > budget ? budget / total : 1;
  const spec = {
    ...base,
    budgetGbp: overAsk ? Math.round(budget * 150) / 100 : budget,
    nodes: base.nodes.map((n) => ({
      ...n,
      budget: { ...n.budget, maxCostGbp: Math.floor(n.budget.maxCostGbp * scale * 10000) / 10000 },
    })),
    goal: `${input.idea.offer} for one ${input.idea.market.buyer}`.slice(0, 240),
  };
  return JSON.stringify({
    action: "submit_graph",
    spec,
    rationale: `Reuses ${pb} as it stands (the best fit in the catalogue).${
      input.archie_feedback.length
        ? ` Took account of: ${input.archie_feedback
            .map((f) => f.reason)
            .join("; ")
            .slice(0, 300)}`
        : ""
    }`,
    assumptions: [`budget £${budget} is 20% of expected value per task, capped`],
  });
}
