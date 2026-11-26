import { join } from "node:path";
import { AgentService, buildSyntheticWorld, fakeModel, loadPlaybooks } from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import { createTask, type GraphNodeJob, runGraphNodeJob } from "@ae/infra";
import { memoryBlobStore, runArchive, type StoredTask, sqlRunStore } from "@ae/storage";
import { openSqliteStorage, sqliteDriver } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../..");

describe("graph run state (data layer plan, step 1)", () => {
  it("a finished run is archived, its run store emptied, and a re-delivered job does nothing", async () => {
    const storage = await openSqliteStorage(":memory:");
    const model = fakeModel();
    await buildSyntheticWorld(storage, model, { count: 20, seed: 11 });
    const entity = (await storage.facts.listCurrent({ status: "verified", limit: 1, offset: 0 }))
      .rows[0]?.entity_id as string;
    // The run store on its own database, as on Cloudflare (a Durable Object, not the main database).
    const blobs = memoryBlobStore();
    const runs = sqlRunStore(sqliteDriver(":memory:"), blobs);
    const jobs: GraphNodeJob[] = [];
    const service: AgentService = new AgentService({
      storage,
      runs,
      blobs,
      playbooks: await loadPlaybooks(join(root, "playbooks")),
      model,
      graphEngine: { enabled: true },
      graphDispatch: async (job) => {
        jobs.push(job);
        await runGraphNodeJob(service.graphDeps, job, service.workflowPort);
      },
    });
    const { task } = await createTask(
      storage,
      loadInfraConfig(),
      service.playbooks,
      service.queue,
      {
        idempotency_key: "rs:1",
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: `opportunity:rs-1:entity:${entity}`,
        lane: "open",
      },
    );
    await service.runQueued();
    const run = (
      ((await storage.tasks.get(task.task_id)) as StoredTask).state as {
        graph_run: { run_id: string };
      }
    ).graph_run;
    // Mid-run (waiting for Archie): state is live in the run store, not archived.
    expect((await runs.latest(run.run_id)).length).toBeGreaterThan(0);
    expect(await runArchive(blobs, run.run_id)).toBeNull();

    await service.decide(task.task_id, "approve", null);
    await service.runQueued();
    expect((await storage.graphRuns.get(run.run_id))?.ended_at).toBeTruthy();
    expect(await runs.latest(run.run_id)).toEqual([]);
    const archive = await runArchive(blobs, run.run_id);
    expect(archive?.node_runs.length).toBeGreaterThan(0);
    expect(archive?.node_runs.every((n) => n.status === "done")).toBe(true);
    expect(await runs.nodeRuns(run.run_id)).toEqual(archive?.node_runs);

    // A queue re-delivery after the end: no node runs again, no cost is recorded again.
    const costs = (await storage.costEvents.forRun(run.run_id)).length;
    const events = await storage.costEvents.range({
      from: "2000-01-01T00:00:00Z",
      to: "2100-01-01T00:00:00Z",
    });
    expect(jobs.length).toBeGreaterThan(0);
    await runGraphNodeJob(service.graphDeps, jobs[0] as GraphNodeJob, service.workflowPort);
    expect((await storage.costEvents.forRun(run.run_id)).length).toBe(costs);
    expect(
      (await storage.costEvents.range({ from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" }))
        .length,
    ).toBe(events.length);
    expect(await runs.latest(run.run_id)).toEqual([]);
  });
});
