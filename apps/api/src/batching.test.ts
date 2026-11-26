import { join } from "node:path";
import { AgentService, buildSyntheticWorld, fakeModel, loadPlaybooks } from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import { createTask } from "@ae/infra";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";

/**
 * Data layer plan, step 5: database round trips per agent step. Before batching, one sme_outreach run
 * up to its approval gate (3 steps) made 15 core writes (5 a step) and 3 telemetry writes. Now each
 * step makes at most 3 core writes: the budget reservation (recorded before the call, like rule 17),
 * the call's cost event (written as it returns: the live tracker) and ONE end-of-step batch; plus one
 * telemetry batch.
 */
describe("batched writes per agent step", () => {
  it("one end-of-step batch per database", async () => {
    const storage = await openSqliteStorage(":memory:");
    const model = fakeModel();
    await buildSyntheticWorld(storage, model, { count: 20, seed: 11 });
    const entity = (await storage.facts.listCurrent({ status: "verified", limit: 1, offset: 0 }))
      .rows[0]?.entity_id as string;
    const service = new AgentService({
      storage,
      playbooks: await loadPlaybooks(join(import.meta.dirname, "../../../playbooks")),
      model,
    });
    const { task } = await createTask(
      storage,
      loadInfraConfig(),
      service.playbooks,
      service.queue,
      {
        idempotency_key: "b:1",
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: `opportunity:b-1:entity:${entity}`,
        lane: "open",
      },
    );
    const writes: Record<string, number> = {};
    const stores = (
      storage.driver as unknown as {
        stores: Record<string, Record<string, (...a: unknown[]) => unknown>>;
      }
    ).stores;
    for (const [name, d] of Object.entries(stores))
      for (const m of ["run", "batch"]) {
        const orig = d[m] as (...a: unknown[]) => unknown;
        d[m] = (...a: unknown[]) => {
          writes[name] = (writes[name] ?? 0) + 1;
          return orig.apply(d, a);
        };
      }
    await service.runQueued();
    const steps = (await storage.runLog.forTask(task.task_id)).length;
    expect(steps).toBe(3);
    // + 2: the task's status at the start ("running") and at the gate ("awaiting_approval").
    expect(writes.core).toBeLessThanOrEqual(3 * steps + 2);
    expect(writes.core).toBeLessThan(15); // the count before batching
    expect(writes.telemetry).toBe(steps);
    expect(writes.facts ?? 0).toBe(0);
  });
});
