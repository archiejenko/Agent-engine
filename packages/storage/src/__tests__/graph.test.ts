import { describe, expect, it } from "vitest";
import type { SqlDriver } from "../driver.ts";
import { migrate, rollback } from "../migrate.ts";
import { loadDownMigrations, loadMigrations } from "../migrations-fs.ts";
import { openSqliteStorage, sqliteDriver } from "../sqlite.ts";

/** Schema snapshot by structure (columns, indexes, triggers), not by stored SQL text. */
async function snapshot(db: SqlDriver) {
  const objs = await db.all<{ type: string; name: string; tbl_name: string }>(
    "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != 'd1_migrations' ORDER BY type, name",
  );
  const out: Record<string, unknown> = {};
  for (const o of objs) {
    if (o.type === "table")
      out[`table:${o.name}`] = await db.all(
        `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${o.name}')`,
      );
    else out[`${o.type}:${o.name}`] = o.tbl_name;
  }
  return out;
}

const GRAPH_MIGRATIONS = ["0020_graph_core.sql", "0021_cost_ledgers.sql", "0022_graph_shapes.sql"];

describe("graph migrations (0020–0022)", () => {
  it("every graph migration has a down file, kept outside the folder wrangler deploys", () => {
    const up = loadMigrations().map((m) => m.name);
    const down = loadDownMigrations();
    for (const n of GRAPH_MIGRATIONS) {
      expect(up).toContain(n);
      expect(down.has(n), n).toBe(true);
    }
    expect(up.some((n) => /down/.test(n))).toBe(false);
  });

  it("run up, down, then up again: the schema returns exactly to before and after", async () => {
    // Up to 0022 only: later migrations (0025 alters cost_events) build on these tables.
    const all = loadMigrations().filter((m) => m.name < "0023");
    const before = sqliteDriver(":memory:");
    await migrate(
      before,
      all.filter((m) => !GRAPH_MIGRATIONS.includes(m.name)),
    );
    const db = sqliteDriver(":memory:");
    await migrate(db, all);
    const up = await snapshot(db);
    const down = loadDownMigrations();
    for (const n of [...GRAPH_MIGRATIONS].reverse()) {
      const m = all.find((x) => x.name === n);
      await rollback(db, m as never, down.get(n) as string);
    }
    expect(await snapshot(db)).toEqual(await snapshot(before));
    expect(await migrate(db, all)).toEqual(GRAPH_MIGRATIONS);
    expect(await snapshot(db)).toEqual(up);
  });
});

describe("cost attribution migration (0025)", () => {
  it("runs up, down and up again, back to exactly the same schema", async () => {
    const n = "0025_cost_event_attribution.sql";
    const all = loadMigrations().filter((m) => m.name <= n);
    const before = sqliteDriver(":memory:");
    await migrate(
      before,
      all.filter((m) => m.name !== n),
    );
    const db = sqliteDriver(":memory:");
    await migrate(db, all);
    const up = await snapshot(db);
    await rollback(
      db,
      all.find((x) => x.name === n) as never,
      loadDownMigrations().get(n) as string,
    );
    expect(await snapshot(db)).toEqual(await snapshot(before));
    expect(await migrate(db, all)).toEqual([n]);
    expect(await snapshot(db)).toEqual(up);
  });
});

describe("graph storage", () => {
  it("the money ledgers are append-only", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.costEvents.add({
      event_id: "c1",
      at: "2026-11-18T10:00:00.000Z",
      run_id: "r1",
      graph_id: null,
      graph_version: null,
      node_id: null,
      task_id: null,
      opportunity_id: null,
      revenue_path: null,
      shape_fingerprint: null,
      mode: "live",
      category: "model",
      unit: "output_tokens",
      quantity: 100,
      unit_price_gbp: 0.0000158,
      amount_gbp: 0.00158,
      price_table_version: "2026-11-18",
      synthetic: false,
      dry_run: true,
    });
    const db = (s as unknown as { db: SqlDriver }).db;
    await expect(db.run("UPDATE cost_events SET amount_gbp = 0")).rejects.toThrow(/append-only/);
    await expect(db.run("DELETE FROM cost_events")).rejects.toThrow(/append-only/);
    expect((await s.costEvents.forRun("r1"))[0]?.amount_gbp).toBeCloseTo(0.00158, 10);
  });

  it("specs, runs, node runs (idempotent start), state and shapes round-trip", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.graphSpecs.add({
      graph_id: "g1",
      version: 1,
      parent_version: null,
      task_id: "t1",
      opportunity_id: null,
      hypothesis_id: "I001",
      spec: { a: 1 },
      content_hash: null,
      registry_version: null,
      compiled: null,
      lane: null,
      worst_case_cost_gbp: null,
      autonomy: null,
      shape_fingerprint: null,
      status: "drafting",
      attempt: 1,
      synthetic: false,
      created_by: "planner",
    });
    await s.graphSpecs.setStatus("g1", 1, "ready");
    expect((await s.graphSpecs.latest("g1"))?.status).toBe("ready");
    await s.graphRuns.add({
      run_id: "r".repeat(32),
      graph_id: "g1",
      version: 1,
      instance_id: null,
      mode: "sandbox",
      status: "running",
      started_at: "2026-11-18T10:00:00.000Z",
      synthetic: false,
    });
    // Per-node runs and state values live in the run store now (run-store.test.ts).
    await s.graphShapes.ensure("f".repeat(64));
    await s.graphShapes.record("f".repeat(64), { met_metric: true, breach: false, cost_gbp: 0.1 });
    expect(await s.graphShapes.get("f".repeat(64))).toMatchObject({
      live_runs: 1,
      met_metric: 1,
      autonomy: "L1",
    });
  });

  it("Archie's reasons go to the decision log, never to the outcome ledger", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.decisionLog.add({
      id: "d1",
      at: "2026-11-18T10:00:00.000Z",
      subject: "graph_plan",
      subject_id: "g1@1",
      graph_id: "g1",
      graph_version: 1,
      decision: "reject",
      reason: "SECRET-REASON-CANARY",
      by: "archie",
      decision_id: null,
    });
    expect((await s.decisionLog.forGraph("g1"))[0]?.reason).toBe("SECRET-REASON-CANARY");
    expect(await s.audit.tablesContaining("SECRET-REASON-CANARY")).toEqual(["decision_log"]);
  });
});
