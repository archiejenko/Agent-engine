import { loadInfraConfig } from "@ae/config";
import { createTask, loadBundledPlaybooks } from "@ae/infra";
import { InMemoryQueue } from "@ae/ports";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { createApp } from "./app.ts";

it("GET /api/today: drafts, letters awaiting batch approval, conflicts, alerts and 7-day money", async () => {
  const storage = await openSqliteStorage(":memory:");
  const cfg = loadInfraConfig();
  const playbooks = await loadBundledPlaybooks();
  const make = async (playbook: "sme_outreach" | "sme_letter", n: number) => {
    const { task } = await createTask(storage, cfg, playbooks, new InMemoryQueue(), {
      idempotency_key: `t:${playbook}:${n}`,
      playbook,
      revenue_path: "sme_outreach",
      source_ref: `opportunity:${n}:entity:0000000${n}`,
      lane: "open",
    });
    await storage.tasks.update(task.task_id, { status: "awaiting_approval" });
    return task;
  };
  await make("sme_outreach", 1);
  await make("sme_outreach", 2);
  const letterTask = await make("sme_letter", 3);
  await storage.tasks.addCost(letterTask.task_id, 1.5);
  await storage.tasks.addRevenue(letterTask.task_id, 4);
  await storage.demoPages.put({
    slug: "d3",
    entity_id: "00000003",
    task_id: letterTask.task_id,
    html: "x",
  });
  await storage.letters.put({
    task_id: letterTask.task_id,
    entity_id: "00000003",
    company_name: "ACME LTD",
    address: ["The Directors"],
    demo_slug: "d3",
    opt_out_code: "LTODAY2",
    pdf_b64: "",
    flags: [],
  });
  await storage.printBatches.create({
    id: "b1",
    week: "2026-W46",
    letter_count: 1,
    flagged_count: 0,
  });
  await storage.letters.setStatus([letterTask.task_id], "batched", "b1");
  await storage.alerts.raise("drift", "x", {});
  const res = await createApp({ runtime: "node", storage: () => storage }).request("/api/today");
  expect(await res.json()).toEqual({
    drafts_waiting: 2,
    letters_awaiting_batch_approval: 1,
    letters_waiting_for_next_batch: 0,
    pending_batches: 1,
    open_conflicts: 0,
    open_alerts: 1,
    last_7_days: { revenue_gbp: 4, cost_gbp: 1.5, margin_gbp: 2.5 },
  });
});
