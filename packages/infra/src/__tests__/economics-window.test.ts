import { loadInfraConfig } from "@ae/config";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { unitEconomics } from "../economics.ts";

describe("unitEconomics window (cockpit U2: compare periods must not overlap)", () => {
  it("`until` closes the window, so a later task isn't counted in an earlier period", async () => {
    const s = await openSqliteStorage(":memory:");
    const task_id = crypto.randomUUID();
    await s.tasks.insertIdempotent({
      task_id,
      idempotency_key: task_id,
      playbook: "sme_outreach",
      playbook_version: 2,
      revenue_path: "sme_outreach",
      source_ref: "lead:sme:entity:ABCD1234",
      lane: "open",
      autonomy: "L0",
      status: "done",
      budget_gbp: 0.4,
      revenue_gbp: 0,
      cost_gbp: 0,
      priority: "outreach",
    });
    const created = (await s.tasks.get(task_id))?.created_at as string;
    const cfg = loadInfraConfig();
    const since = new Date(Date.parse(created) - 3_600_000).toISOString();
    const open = await unitEconomics(s, cfg, { since, includeSynthetic: false });
    expect(open.by_playbook.map((p) => p.tasks)).toEqual([1]);
    // A window that ends exactly when the task was created leaves it out ([since, until)).
    const closed = await unitEconomics(s, cfg, { since, until: created, includeSynthetic: false });
    expect(closed.by_playbook).toEqual([]);
  });
});
