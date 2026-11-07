import { z } from "zod";
import { Gbp, IsoDateTime, Lane, Slug, Uuid } from "./common.ts";

export const RevenuePath = z.enum([
  "sme_outreach",
  "x402_check",
  "monitoring",
  "human_check",
  "agent_house",
  "ma_brief",
  "internal",
]);
export type RevenuePath = z.infer<typeof RevenuePath>;

/** L0 draft only · L1 act after per-item approval · L2 act within limits, sampled review · L3 automatic */
export const Autonomy = z.enum(["L0", "L1", "L2", "L3"]);
export type Autonomy = z.infer<typeof Autonomy>;

export const TaskStatus = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "cancelled",
]);

export const Task = z.object({
  task_id: Uuid,
  idempotency_key: z.string().min(1).max(200),
  playbook: Slug,
  playbook_version: z.number().int().positive(),
  revenue_path: RevenuePath,
  source_ref: z.string().min(1),
  lane: Lane,
  autonomy: Autonomy,
  status: TaskStatus,
  budget_gbp: Gbp,
  revenue_gbp: Gbp,
  cost_gbp: Gbp,
});
export type Task = z.infer<typeof Task>;

/** What a trigger passes to createTask(). The rest is filled from the playbook. */
export const TaskInput = Task.pick({
  idempotency_key: true,
  playbook: true,
  revenue_path: true,
  source_ref: true,
  lane: true,
});
export type TaskInput = z.infer<typeof TaskInput>;

export const Role = z.enum(["researcher", "writer", "checker", "operator"]);
export type Role = z.infer<typeof Role>;

export const RoleStep = z.object({
  id: Slug,
  role: Role,
  tools: z.array(Slug),
  output: Slug,
});
export const GateStep = z.object({ id: Slug, gate: z.literal("archie") });
export const PlaybookStep = z.union([RoleStep, GateStep]);

/** Front matter of playbooks/<name>/SKILL.md */
export const PlaybookSpec = z
  .object({
    playbook: Slug,
    version: z.number().int().positive(),
    revenue_path: RevenuePath,
    autonomy: Autonomy,
    budget_gbp: z.number().positive(),
    steps: z.array(PlaybookStep).min(1),
    done_when: z.string().min(1),
  })
  .superRefine((p, ctx) => {
    const ids = p.steps.map((s) => s.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "step ids must be unique" });
    }
    const hasGate = p.steps.some((s) => "gate" in s);
    if ((p.autonomy === "L0" || p.autonomy === "L1") && !hasGate) {
      ctx.addIssue({
        code: "custom",
        path: ["steps"],
        message: "L0 and L1 playbooks must include an approval gate",
      });
    }
  });
export type PlaybookSpec = z.infer<typeof PlaybookSpec>;

/**
 * Tool registry entry. Guardrails enforced here at the contract level:
 * - external tools (act outside / serve a customer) can never run in the licensed lane (guardrail 1)
 * - external tools can only be called by the operator role (guardrail 4)
 */
export const ToolRegistration = z
  .object({
    name: Slug,
    description: z.string().min(1),
    allowed_lanes: z.array(Lane).min(1),
    external: z.boolean(),
    serves_customer: z.boolean(),
    allowed_roles: z.array(Role).min(1),
    rate_limit_per_min: z.number().int().positive(),
    cost_gbp_per_call: Gbp,
  })
  .superRefine((t, ctx) => {
    if ((t.external || t.serves_customer) && t.allowed_lanes.includes("licensed")) {
      ctx.addIssue({
        code: "custom",
        path: ["allowed_lanes"],
        message: "external or customer-serving tools cannot allow the licensed lane",
      });
    }
    if (t.external && t.allowed_roles.some((r) => r !== "operator")) {
      ctx.addIssue({
        code: "custom",
        path: ["allowed_roles"],
        message: "only the operator role may call external tools",
      });
    }
  });
export type ToolRegistration = z.infer<typeof ToolRegistration>;

export const ToolCall = z.object({
  tool: Slug,
  args: z.json(),
  result: z.json(),
  blocked: z.boolean(),
  error: z.string().nullable(),
});

export const RunLogEntry = z.object({
  task_id: Uuid,
  step_id: Slug,
  role: z.union([Role, z.literal("gate")]),
  model: z.string().nullable(),
  tool_calls: z.array(ToolCall),
  output: z.json(),
  check_result: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }).nullable(),
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  cost_gbp: Gbp,
  duration_ms: z.number().int().nonnegative(),
  timestamp: IsoDateTime,
});
export type RunLogEntry = z.infer<typeof RunLogEntry>;

export const Approval = z
  .object({
    task_id: Uuid,
    step_id: Slug,
    item_shown: z.json(),
    decision: z.enum(["approve", "edit", "reject"]),
    edited_text: z.string().min(1).nullable(),
    decided_at: IsoDateTime,
  })
  .superRefine((a, ctx) => {
    if (a.decision === "edit" && a.edited_text === null) {
      ctx.addIssue({
        code: "custom",
        path: ["edited_text"],
        message: "an edit needs the edited text",
      });
    }
    if (a.decision !== "edit" && a.edited_text !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["edited_text"],
        message: "edited_text is only for edit decisions",
      });
    }
  });
export type Approval = z.infer<typeof Approval>;
