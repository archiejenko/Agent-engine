import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { repeatedPhrases, stage5Review } from "../stage5.ts";

async function draftTask(
  storage: Awaited<ReturnType<typeof openSqliteStorage>>,
  o: {
    model: string;
    checks: { passed: boolean; reasons: string[] }[];
    body: string;
    decision?: "approve" | "edit" | "reject";
    synthetic?: boolean;
  },
) {
  const task_id = crypto.randomUUID();
  await storage.tasks.insertIdempotent({
    task_id,
    idempotency_key: task_id,
    playbook: "sme_outreach",
    playbook_version: 2,
    revenue_path: "sme_outreach",
    source_ref: "opportunity:x",
    lane: "open",
    autonomy: "L1",
    status: "awaiting_approval",
    budget_gbp: 0.4,
    revenue_gbp: 0,
    cost_gbp: 0,
    priority: "outreach",
    state: { outputs: { email_draft: { subject: "s", body: o.body, claims: [] } } },
    ...(o.synthetic ? { synthetic: true } : {}),
  });
  const entry = (
    step_id: string,
    role: "writer" | "checker",
    check: { passed: boolean; reasons: string[] } | null,
  ) =>
    storage.runLog.append({
      task_id,
      step_id,
      role,
      model: o.model,
      tool_calls: [],
      output: {},
      check_result: check,
      tokens: { input: 1000, output: 300 },
      cost_gbp: 0.02,
      duration_ms: 10,
      timestamp: new Date().toISOString(),
    });
  for (const c of o.checks) {
    await entry("draft", "writer", null);
    await entry("check", "checker", c);
  }
  if (o.decision)
    await storage.approvals.add({
      task_id,
      step_id: "approve",
      item_shown: {},
      decision: o.decision,
      edited_text: o.decision === "edit" ? "x" : null,
    });
  return task_id;
}

describe("Stage 5 review (real drafts only)", () => {
  it("summarises pass rates, rule rejections, cost, edits and repeated phrases; ignores fake-model and simulated drafts", async () => {
    const s = await openSqliteStorage(":memory:");
    const real = "claude-opus-5-5";
    const shared = "Your website still lists a 2019 copyright notice and";
    await draftTask(s, {
      model: real,
      checks: [{ passed: true, reasons: [] }],
      body: `${shared} more A.`,
      decision: "approve",
    });
    await draftTask(s, {
      model: real,
      checks: [
        { passed: false, reasons: ["company name used 3 times (max 2)"] },
        { passed: true, reasons: [] },
      ],
      body: `${shared} more B.`,
      decision: "edit",
    });
    await draftTask(s, {
      model: real,
      checks: [
        { passed: false, reasons: ["company name used 4 times (max 2)"] },
        { passed: false, reasons: ['"I noticed" used 2 times'] },
      ],
      body: `${shared} more C.`,
    });
    await draftTask(s, {
      model: "fake-model",
      checks: [{ passed: true, reasons: [] }],
      body: "fake",
    });
    await draftTask(s, {
      model: real,
      checks: [{ passed: true, reasons: [] }],
      body: "sim",
      synthetic: true,
    });
    const r = await stage5Review(s);
    expect(r.drafts).toBe(3);
    expect(r.models.writer).toEqual([real]);
    expect(r.first_time_pass_rate).toBeCloseTo(1 / 3, 10);
    expect(r.passed_after_retry).toBe(1);
    expect(r.failed_twice).toBe(1);
    expect(r.rejection_reasons[0]).toEqual({ reason: "company name used N times", count: 2 });
    expect(r.cost_per_draft_gbp.mean).toBeCloseTo((0.04 + 0.08 + 0.08) / 3, 10);
    expect(r.decisions).toEqual({ approved: 1, edited: 1, rejected: 0, waiting: 1 });
    expect(r.edit_rate).toBeCloseTo(0.5, 10);
    expect(r.repeated_phrases[0]).toMatchObject({ drafts: 3, everywhere: true });
    expect(JSON.stringify(r)).not.toMatch(/holdout|cohort|"arm"/);
  });

  it("repeated phrases need at least three drafts; each phrase counts once per draft", () => {
    expect(repeatedPhrases(["a b c d a b c d", "a b c d", "x y z w"])).toEqual([]);
    expect(repeatedPhrases(["a b c d", "a b c d", "a b c d e"])[0]).toEqual({
      phrase: "a b c d",
      drafts: 3,
      everywhere: true,
    });
  });
});
