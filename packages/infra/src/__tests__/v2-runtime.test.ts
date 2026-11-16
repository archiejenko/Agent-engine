import { loadInfraConfig, loadTriggersConfig, TriggersConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { FakeChangeStream } from "@ae/verification";
import { beforeEach, describe, expect, it } from "vitest";
import { type ChangeFeedSource, runFeedOnce, streamFeedSource } from "../change-feed.ts";
import { K } from "../controls.ts";
import { effectKeyFor } from "../tools.ts";
import { type CompanyEvent, chunkEvents } from "../triggers.ts";
import { LocalWorkflowEngine, type WorkflowDef } from "../workflow.ts";

const cfg = loadInfraConfig();
let storage: Storage;
beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
});

describe("local workflow engine", () => {
  it("sleeps without blocking, then resumes and never re-runs completed steps", async () => {
    let now = new Date("2026-11-16T10:00:00Z");
    const runs: string[] = [];
    const wf: WorkflowDef<unknown, string> = {
      name: "w",
      playbook: "sme_outreach",
      run: async (_p, step) => {
        await step.do("a", async () => runs.push("a"));
        await step.sleep("a week", 7 * 86_400_000);
        await step.do("b", async () => runs.push("b"));
        return "ok";
      },
    };
    const engine = new LocalWorkflowEngine(
      storage,
      cfg,
      [wf as WorkflowDef<never, unknown>],
      () => now,
    );
    const i = await engine.start("w", {});
    expect(i.status).toBe("sleeping");
    expect(await engine.tick()).toBe(0); // not due
    now = new Date("2026-11-23T10:00:01Z");
    await engine.tick();
    expect((await storage.workflows.get(i.id))?.status).toBe("complete");
    expect(runs).toEqual(["a", "b"]);
  });

  it("a dry-run instance (started with the kill switch on) keeps going; it can't act externally", async () => {
    await storage.controls.set(K.global, true, "test");
    const wf: WorkflowDef<unknown, number> = {
      name: "d",
      playbook: "sme_outreach",
      run: async (_p, step) => step.do("x", async () => 1),
    };
    const engine = new LocalWorkflowEngine(storage, cfg, [wf as WorkflowDef<never, unknown>]);
    const i = await engine.start("d", {});
    expect(i.dry_run).toBe(true);
    expect(i.status).toBe("complete");
  });

  it("a step that keeps failing errors the instance after its retries", async () => {
    let n = 0;
    const wf: WorkflowDef<unknown, unknown> = {
      name: "f",
      playbook: "sme_outreach",
      run: async (_p, step) =>
        step.do("boom", async () => {
          n++;
          throw new Error("nope");
        }),
    };
    const engine = new LocalWorkflowEngine(
      storage,
      cfg,
      [wf as WorkflowDef<never, unknown>],
      undefined,
      2,
    );
    const i = await engine.start("f", {});
    expect(i.status).toBe("errored");
    expect(n).toBe(3);
  });
});

describe("recorded external effects", () => {
  it("the key is stable for the same call and differs for dry-run vs live", async () => {
    const a = await effectKeyFor("t1", "send_email", { b: 1, a: [2, { y: 1, x: 2 }] }, false);
    const b = await effectKeyFor("t1", "send_email", { a: [2, { x: 2, y: 1 }], b: 1 }, false);
    expect(a).toBe(b);
    expect(await effectKeyFor("t1", "send_email", { b: 1, a: [2, { y: 1, x: 2 }] }, true)).not.toBe(
      a,
    );
  });
});

describe("triggers config and feed", () => {
  it("the shipped config is valid; a model rule must be the explain action", () => {
    const c = loadTriggersConfig();
    expect(c.rules.filter((r) => r.model).every((r) => r.action === "explain")).toBe(true);
    const bad = { ...c, rules: [{ ...c.rules[0], model: true }] };
    expect(TriggersConfig.safeParse(bad).success).toBe(false);
  });

  it("events are batched for the queue, never dropped", () => {
    const c = loadTriggersConfig();
    const ev = (i: number): CompanyEvent => ({
      id: String(i),
      entity_id: "01234567",
      kind: "company",
      data: {},
      published_at: "2026-11-16T00:00:00Z",
    });
    const batches = chunkEvents(
      Array.from({ length: c.max_events_per_batch * 2 + 1 }, (_, i) => ev(i)),
      c,
    );
    expect(batches.length).toBe(3);
    expect(batches.flat().length).toBe(c.max_events_per_batch * 2 + 1);
  });

  it("the feed position moves only after events are delivered", async () => {
    const source: ChangeFeedSource = {
      name: "test",
      read: async () => ({
        events: [{ id: "e1", entity_id: "01234567", kind: "company", data: {}, published_at: "x" }],
        timepoint: "42",
      }),
    };
    const start = { timepoint: "41", last_event_at: null, last_read_at: null };
    await expect(
      runFeedOnce(
        source,
        start,
        async () => {
          throw new Error("queue down");
        },
        { budgetMs: 10 },
      ),
    ).rejects.toThrow("queue down");
    const next = await runFeedOnce(source, start, async () => {}, { budgetMs: 10 });
    expect(next.timepoint).toBe("42");
  });
});

describe("Companies House stream as the change feed", () => {
  it("reads each stream, resumes per stream, and keeps the filing category for the rules", async () => {
    const ev = (stream: "companies" | "filings", tp: number, data: Record<string, unknown>) => ({
      stream,
      timepoint: tp,
      type: "changed",
      published_at: "2026-11-16T00:00:00Z",
      resource_uri: `/company/0123456${tp % 10}`,
      company_number: `0123456${tp % 10}`,
      data,
    });
    const fake = new FakeChangeStream([
      ev("companies", 1, { company_status: "liquidation" }),
      ev("filings", 2, { category: "accounts" }),
      ev("filings", 3, { category: "officers" }),
    ]);
    const src = streamFeedSource(fake, ["companies", "filings"]);
    const first = await src.read(null, 2000);
    expect(first.events.map((e) => [e.kind, e.data])).toEqual([
      ["company", { company_status: "liquidation" }],
      ["filing", { category: "accounts" }],
      ["filing", { category: "officers" }],
    ]);
    expect(JSON.parse(first.timepoint as string)).toEqual({ companies: 1, filings: 3 });
    const again = await src.read(first.timepoint, 2000);
    expect(again.events).toEqual([]); // resumed past everything already read
  });
});
