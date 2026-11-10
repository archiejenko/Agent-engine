import { loadInfraConfig } from "@ae/config";
import { InMemoryQueue } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { contactBlock } from "../contact.ts";
import { loadBundledPlaybooks } from "../playbook.ts";
import { createTask } from "../tasks.ts";

const cfg = loadInfraConfig();
const E = "01234567";
let storage: Storage;
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
});

const email = (thread = "opportunity:o1") =>
  storage.outbox.add({
    task_id: "t-email",
    thread_id: thread,
    attempt: 1,
    entity_id: E,
    recipient: "info@acme.example",
    sender: "a@x",
    subject: "s",
    body: "b",
    status: "dry_run",
    reason: null,
  });
const letter = async (task: string) => {
  await storage.demoPages.put({ slug: `d-${task}`, entity_id: E, task_id: task, html: "x" });
  await storage.letters.put({
    task_id: task,
    entity_id: E,
    company_name: "ACME LTD",
    address: ["The Directors"],
    demo_slug: `d-${task}`,
    opt_out_code: `L${task.toUpperCase().padEnd(6, "X").slice(0, 6)}`,
    pdf_b64: "",
    flags: [],
  });
};

describe("per-company contact cooldown (all playbooks, all modules)", () => {
  it("a company with nothing on record can be contacted", async () => {
    expect(await contactBlock(storage, cfg, E)).toBeNull();
  });

  it("an email within the cooldown blocks a new email or letter; a follow-up in the same thread is fine", async () => {
    await email();
    expect(await contactBlock(storage, cfg, E)).toMatch(/emailed on .* \(cooldown 90 days\)/);
    expect(await contactBlock(storage, cfg, E, { threadId: "opportunity:o1" })).toBeNull();
    expect(
      await contactBlock(storage, cfg, E, { now: days(cfg.outreach.contact_cooldown_days + 1) }),
    ).toBeNull();
  });

  it("a letter pending in any batch blocks email and another letter; an approved one blocks for the cooldown", async () => {
    await letter("t1");
    expect(await contactBlock(storage, cfg, E)).toMatch(/letter is already pending/);
    expect(await contactBlock(storage, cfg, E, { taskId: "t1" })).toBeNull(); // the letter itself
    await storage.letters.setStatus(["t1"], "batched", "2026-W46-x");
    expect(await contactBlock(storage, cfg, E)).toMatch(/pending in print batch 2026-W46-x/);
    await storage.letters.setStatus(["t1"], "approved");
    expect(await contactBlock(storage, cfg, E)).toMatch(/letter was sent on/);
    expect(await contactBlock(storage, cfg, E, { now: days(91) })).toBeNull();
    await storage.letters.setStatus(["t1"], "rejected"); // left out of the batch: not a contact
    expect(await contactBlock(storage, cfg, E)).toBeNull();
  });

  it("an email or letter draft already in progress blocks a second one", async () => {
    const playbooks = await loadBundledPlaybooks();
    const { task } = await createTask(storage, cfg, playbooks, new InMemoryQueue(), {
      idempotency_key: "opportunity:x",
      playbook: "sme_letter",
      revenue_path: "sme_outreach",
      source_ref: `opportunity:x:entity:${E}`,
      lane: "open",
    });
    expect(await contactBlock(storage, cfg, E)).toMatch(/a letter draft is already in progress/);
    expect(await contactBlock(storage, cfg, E, { taskId: task.task_id })).toBeNull();
  });
});

describe("letter costs", () => {
  it("approving a batch adds print + postage to each approved letter's task (margins are real)", async () => {
    const { decidePrintBatch } = await import("../playbooks/sme_letter.ts");
    const playbooks = await loadBundledPlaybooks();
    const { task } = await createTask(storage, cfg, playbooks, new InMemoryQueue(), {
      idempotency_key: "opportunity:cost",
      playbook: "sme_letter",
      revenue_path: "sme_outreach",
      source_ref: `opportunity:cost:entity:${E}`,
      lane: "open",
    });
    await storage.demoPages.put({ slug: "dc", entity_id: E, task_id: task.task_id, html: "x" });
    await storage.letters.put({
      task_id: task.task_id,
      entity_id: E,
      company_name: "ACME LTD",
      address: ["The Directors"],
      demo_slug: "dc",
      opt_out_code: "LCOST22",
      pdf_b64: "",
      flags: [],
    });
    await storage.printBatches.create({
      id: "b1",
      week: "2026-W46",
      letter_count: 1,
      flagged_count: 0,
    });
    await storage.letters.setStatus([task.task_id], "batched", "b1");
    const r = await decidePrintBatch(storage, cfg, "b1", "approve", [], async () => {});
    const per = cfg.letters.print_cost_gbp + cfg.letters.postage_gbp;
    expect(r.print_and_post_gbp).toBeCloseTo(per, 6);
    expect((await storage.tasks.get(task.task_id))?.cost_gbp).toBeCloseTo(per, 6);
    expect((await storage.runLog.forTask(task.task_id)).map((e) => e.step_id)).toContain(
      "print_and_post",
    );
    // A big batch's print and postage (approved by Archie) must not trip the automatic daily caps.
    for (let i = 0; i < 20; i++)
      await storage.runLog.append({
        task_id: task.task_id,
        step_id: "print_and_post",
        role: "gate",
        model: null,
        tool_calls: [],
        output: {},
        check_result: null,
        tokens: { input: 0, output: 0 },
        cost_gbp: per,
        duration_ms: 0,
        timestamp: new Date().toISOString(),
      });
    const { checkSpend } = await import("../controls.ts");
    await expect(
      checkSpend(
        storage,
        cfg,
        { task_id: task.task_id, playbook: "sme_letter", budget_gbp: 1, cost_gbp: 0 },
        0.01,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("cooldown status and the daily digest", () => {
  it("says when the company was contacted and when the cooldown ends", async () => {
    const { contactStatus } = await import("../contact.ts");
    await email();
    const st = await contactStatus(storage, cfg, E);
    const today = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + cfg.outreach.contact_cooldown_days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(st).toMatchObject({ contacted_on: today, until });
  });

  it("blocked duplicates make ONE alert per day, counted once per company and reason", async () => {
    const { recordContactBlocked } = await import("../contact.ts");
    const now = new Date("2026-11-10T09:00:00Z");
    await recordContactBlocked(
      storage,
      "00000001",
      "sme_letter",
      "a letter is already pending",
      now,
    );
    await recordContactBlocked(storage, "00000002", "sme_outreach", "emailed on 2026-11-01", now);
    await recordContactBlocked(
      storage,
      "00000001",
      "sme_letter",
      "a letter is already pending",
      now,
    );
    let alerts = (await storage.alerts.list({ limit: 50 })).filter(
      (a) => a.kind === "contact_blocked",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.message).toMatch(/^2 duplicates blocked today/);
    // The next day starts a new digest.
    await recordContactBlocked(
      storage,
      "00000003",
      "sme_letter",
      "x",
      new Date("2026-11-11T09:00:00Z"),
    );
    alerts = (await storage.alerts.list({ limit: 50 })).filter((a) => a.kind === "contact_blocked");
    expect(alerts.map((a) => a.message.split(" ")[0])).toEqual(["1", "2"]);
  });
});
