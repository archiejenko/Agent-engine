import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { memoryBlobStore } from "../blobs.ts";
import { type DurableSqlLike, durableSqlDriver } from "../do-sql.ts";
import type { SqlValue } from "../driver.ts";
import { type RunStore, runArchive, runArchiveKey, sqlRunStore } from "../run-store.ts";
import { sqliteDriver } from "../sqlite.ts";

/** A stand-in for a Durable Object's `ctx.storage` (same SQLite engine, same call shapes). */
function fakeDurableStorage(): DurableSqlLike & { tables(): string[] } {
  const db = new Database(":memory:");
  return {
    sql: {
      exec(query: string, ...b: SqlValue[]) {
        const st = db.prepare(query);
        if (st.reader) {
          const rows = st.all(...b) as Record<string, unknown>[];
          return { toArray: () => rows, rowsWritten: 0 };
        }
        const r = st.run(...b);
        return { toArray: () => [], rowsWritten: r.changes };
      },
    },
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    tables: () =>
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      )
        .map((r) => r.name)
        .sort(),
  };
}

const RUN = "r".repeat(32);
const stores: [string, () => { store: RunStore; blobs: ReturnType<typeof memoryBlobStore> }][] = [
  [
    "a SQLite file",
    () => {
      const blobs = memoryBlobStore();
      return { store: sqlRunStore(sqliteDriver(":memory:"), blobs), blobs };
    },
  ],
  [
    "a Durable Object's SQL storage",
    () => {
      const blobs = memoryBlobStore();
      return { store: sqlRunStore(durableSqlDriver(fakeDurableStorage()), blobs), blobs };
    },
  ],
];

describe.each(stores)("run store on %s", (_name, make) => {
  it("node runs are idempotent on (run, node, iteration) and keep the recorded output", async () => {
    const { store } = make();
    const a = await store.start(RUN, "draft", 0);
    const b = await store.start(RUN, "draft", 0);
    expect(a.status).toBe("running");
    expect(b.started_at).toBe(a.started_at);
    await store.finish(RUN, "draft", 0, {
      status: "done",
      cost_gbp: 0.02,
      recorded_model_output: { text: "hi" },
    });
    // A re-delivered job finds the finished row and reuses it: the node never runs twice.
    const again = await store.start(RUN, "draft", 0);
    expect(again).toMatchObject({ status: "done", recorded_model_output: { text: "hi" } });
    expect((await store.get(RUN, "draft", 0))?.cost_gbp).toBeCloseTo(0.02, 12);
    expect(await store.get(RUN, "nope", 0)).toBeNull();
  });

  it("a recorded output over 8 KiB goes to the blob store and the archive still holds it", async () => {
    const { store, blobs } = make();
    const text = "y".repeat(9000);
    await store.start(RUN, "big", 0);
    await store.finish(RUN, "big", 0, { status: "done", recorded_model_output: { text } });
    expect(blobs.keys().some((k) => k.startsWith(`runs/${RUN}`))).toBe(true);
    expect((await store.get(RUN, "big", 0))?.recorded_model_output).toEqual({ text });
    await store.close(RUN);
    expect((await runArchive(blobs, RUN))?.node_runs[0]?.recorded_model_output).toEqual({ text });
  });

  it("state keeps every iteration and reads back the latest of each key", async () => {
    const { store } = make();
    const put = (key: string, iteration: number, value: unknown) =>
      store.put({
        run_id: RUN,
        key,
        iteration,
        value,
        untrusted: key === "page",
        lane: "open",
        written_by: "n",
      });
    await put("draft", 0, "v0");
    await put("draft", 1, "v1");
    await put("page", 0, { html: "<p>x</p>" });
    await put("draft", 0, "v0 again"); // a replayed write of the same iteration overwrites, never adds
    const latest = await store.latest(RUN);
    expect(latest.find((v) => v.key === "draft")).toMatchObject({ iteration: 1, value: "v1" });
    expect(latest.find((v) => v.key === "page")).toMatchObject({ untrusted: true });
    expect(await store.latest("other")).toEqual([]);
  });

  it("close() archives the run once, empties it, and reads come from the archive after", async () => {
    const { store, blobs } = make();
    await store.start(RUN, "a", 0);
    await store.finish(RUN, "a", 0, { status: "done", recorded_model_output: { n: 1 } });
    await store.put({
      run_id: RUN,
      key: "k",
      iteration: 0,
      value: 1,
      untrusted: false,
      lane: "open",
      written_by: "a",
    });
    const r = await store.close(RUN);
    expect(r).toEqual({ archive_key: runArchiveKey(RUN), node_runs: 1, state_values: 1 });
    expect(blobs.keys()).toEqual([runArchiveKey(RUN)]);
    expect(await store.latest(RUN)).toEqual([]);
    expect((await store.nodeRuns(RUN)).map((n) => n.recorded_model_output)).toEqual([{ n: 1 }]);
    const archive = await runArchive(blobs, RUN);
    expect(archive?.state_values.map((v) => v.key)).toEqual(["k"]);
    // Closing twice changes nothing and keeps the archive.
    expect(await store.close(RUN)).toEqual(r);
    expect(blobs.keys()).toEqual([runArchiveKey(RUN)]);
  });
});

describe("Durable Object SQL adapter", () => {
  it("creates the run tables inside the object and rolls a failed batch back", async () => {
    const st = fakeDurableStorage();
    const d = durableSqlDriver(st);
    const store = sqlRunStore(d, memoryBlobStore());
    await store.start(RUN, "a", 0);
    expect(st.tables()).toEqual(["run_node_runs", "run_state_values"]);
    await expect(
      d.batch([
        { sql: "DELETE FROM run_node_runs WHERE run_id = ?", params: [RUN] },
        { sql: "INSERT INTO no_such_table VALUES (1)" },
      ]),
    ).rejects.toThrow();
    expect(await store.nodeRuns(RUN)).toHaveLength(1);
  });
});
