/**
 * The catalogue of registered deterministic functions a graph may use (node kind "function", and
 * `successMetric.measuredBy`). G0 declares them (name, what they read and write, config schema, cost);
 * G1 adds the implementations. A graph can't name a function that isn't here (compiler rule 2).
 */
export interface FunctionDef {
  id: string;
  description: string;
  /** JSON-schema-like description of allowed config keys; {} = no config allowed. */
  config: Record<string, { type: "string" | "number" | "boolean"; required?: boolean }>;
  /** Marks the outreach checks compiler rule 12 looks for. */
  outreach_check?: "suppression" | "cooldown";
  /** Can measure a success metric. */
  metric?: boolean;
  cost_gbp: number;
}

export const FUNCTION_CATALOGUE: FunctionDef[] = [
  {
    id: "suppression_check",
    description: "Refuses a send to any suppressed company or address (one global list).",
    config: {},
    outreach_check: "suppression",
    cost_gbp: 0,
  },
  {
    id: "contact_cooldown",
    description: "Refuses a send inside the 90-day per-company contact cooldown.",
    config: {},
    outreach_check: "cooldown",
    cost_gbp: 0,
  },
  {
    id: "expected_value",
    description: "Expected value in pounds from the ledger-trained P(paid) (rules 11–12).",
    config: { playbook: { type: "string", required: true } },
    cost_gbp: 0,
  },
  {
    id: "suggested_budget",
    description:
      "Budget suggestion: 20% of EV capped by the per-task cap; explore budget for seeded ideas.",
    config: {},
    cost_gbp: 0,
  },
  {
    id: "pick_channel",
    description: "Email if a role address is known and PECR allows, else letter, else none.",
    config: {},
    cost_gbp: 0,
  },
  {
    id: "count_replies",
    description: "Success metric: replies attributed to the run (outcome ledger, real only).",
    config: {},
    metric: true,
    cost_gbp: 0,
  },
  {
    id: "count_paid",
    description: "Success metric: settled payments attributed to the run.",
    config: {},
    metric: true,
    cost_gbp: 0,
  },
  {
    id: "draft_approved",
    description: "Success metric: the draft was approved by Archie (L0/L1 drafting graphs).",
    config: {},
    metric: true,
    cost_gbp: 0,
  },
];

export const functionById = (id: string) => FUNCTION_CATALOGUE.find((f) => f.id === id) ?? null;
