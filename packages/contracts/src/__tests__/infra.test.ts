import { describe, expect, it } from "vitest";
import {
  Approval,
  PlaybookSpec,
  RunLogEntry,
  Task,
  TaskInput,
  ToolRegistration,
} from "../index.ts";

const playbook = {
  playbook: "sme_outreach",
  version: 1,
  revenue_path: "sme_outreach",
  autonomy: "L0",
  budget_gbp: 0.4,
  steps: [
    {
      id: "research",
      role: "researcher",
      tools: ["verified_facts", "web_fetch"],
      output: "company_brief",
    },
    { id: "draft", role: "writer", tools: [], output: "email_draft" },
    { id: "check", role: "checker", tools: ["verified_facts"], output: "pass_or_fail" },
    { id: "approve", gate: "archie" },
  ],
  done_when: "approved_or_rejected",
};

describe("PlaybookSpec", () => {
  it("accepts the sme_outreach example", () => {
    expect(PlaybookSpec.safeParse(playbook).success).toBe(true);
  });
  it("L0/L1 playbooks must contain an approval gate", () => {
    const noGate = { ...playbook, steps: playbook.steps.slice(0, 3) };
    expect(PlaybookSpec.safeParse(noGate).success).toBe(false);
    expect(PlaybookSpec.safeParse({ ...noGate, autonomy: "L3" }).success).toBe(true);
  });
  it("step ids must be unique", () => {
    const dup = { ...playbook, steps: [...playbook.steps, { id: "draft", gate: "archie" }] };
    expect(PlaybookSpec.safeParse(dup).success).toBe(false);
  });
});

describe("Task", () => {
  const task = {
    task_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    idempotency_key: "opp:1b9d6bcd",
    playbook: "sme_outreach",
    playbook_version: 1,
    revenue_path: "sme_outreach",
    source_ref: "opportunity:1b9d6bcd",
    lane: "open",
    autonomy: "L0",
    status: "queued",
    budget_gbp: 0.4,
    revenue_gbp: 0,
    cost_gbp: 0,
  };
  it("accepts a task", () => {
    expect(Task.safeParse(task).success).toBe(true);
  });
  it("rejects unknown revenue paths and negative money", () => {
    expect(Task.safeParse({ ...task, revenue_path: "crypto" }).success).toBe(false);
    expect(Task.safeParse({ ...task, cost_gbp: -1 }).success).toBe(false);
  });
  it("TaskInput requires an idempotency key", () => {
    const { idempotency_key: _, ...rest } = task;
    expect(TaskInput.safeParse(rest).success).toBe(false);
  });
});

describe("ToolRegistration (guardrails 1 and 4)", () => {
  const tool = {
    name: "send_email",
    description: "Sends an email",
    allowed_lanes: ["open"],
    external: true,
    serves_customer: false,
    allowed_roles: ["operator"],
    rate_limit_per_min: 10,
    cost_gbp_per_call: 0.001,
  };
  it("accepts an external, operator-only, open-lane tool", () => {
    expect(ToolRegistration.safeParse(tool).success).toBe(true);
  });
  it("external tools cannot allow the licensed lane", () => {
    expect(
      ToolRegistration.safeParse({ ...tool, allowed_lanes: ["open", "licensed"] }).success,
    ).toBe(false);
  });
  it("customer-serving tools cannot allow the licensed lane", () => {
    expect(
      ToolRegistration.safeParse({
        ...tool,
        external: false,
        serves_customer: true,
        allowed_lanes: ["licensed"],
      }).success,
    ).toBe(false);
  });
  it("only the operator may call external tools", () => {
    expect(
      ToolRegistration.safeParse({ ...tool, allowed_roles: ["researcher", "operator"] }).success,
    ).toBe(false);
  });
  it("internal tools may allow licensed and any role", () => {
    expect(
      ToolRegistration.safeParse({
        ...tool,
        name: "verified_facts",
        external: false,
        allowed_lanes: ["open", "licensed"],
        allowed_roles: ["researcher", "checker"],
      }).success,
    ).toBe(true);
  });
});

describe("RunLogEntry and Approval", () => {
  it("accepts a run log entry", () => {
    expect(
      RunLogEntry.safeParse({
        task_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
        step_id: "draft",
        role: "writer",
        model: "claude-model-id",
        tool_calls: [],
        output: { text: "Hello" },
        check_result: null,
        tokens: { input: 1000, output: 200 },
        cost_gbp: 0.01,
        duration_ms: 2300,
        timestamp: "2026-11-07T10:00:00Z",
      }).success,
    ).toBe(true);
  });
  const approval = {
    task_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    step_id: "approve",
    item_shown: { draft: "Hi" },
    decision: "edit",
    edited_text: "Hi there",
    decided_at: "2026-11-07T10:00:00Z",
  };
  it("edit decisions need the edited text; others must not have it", () => {
    expect(Approval.safeParse(approval).success).toBe(true);
    expect(Approval.safeParse({ ...approval, edited_text: null }).success).toBe(false);
    expect(Approval.safeParse({ ...approval, decision: "approve" }).success).toBe(false);
  });
});
