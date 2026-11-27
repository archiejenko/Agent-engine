import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { SqlDriver } from "../driver.ts";
import { LOCAL_RUNTIME_SCHEMA } from "../local-runtime.ts";
import { migrate, rollback } from "../migrate.ts";
import {
  loadDownMigrations,
  loadMigrations,
  migrationsDirFor,
  migrationsDownDirFor,
} from "../migrations-fs.ts";
import {
  CrossStoreError,
  D1_STORES,
  PLACEMENT,
  routedDriver,
  type Store,
  storeOf,
  tablesIn,
} from "../placement.ts";
import { RUN_STORE_SCHEMA } from "../run-store.ts";
import { openSqliteStorage, sqliteDriver, storePaths } from "../sqlite.ts";

async function schemaOf(d: SqlDriver) {
  const tables = (
    await d.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name",
    )
  ).map((r) => r.name);
  const fks: { from: string; to: string }[] = [];
  for (const t of tables)
    for (const f of await d.all<{ table: string }>(`PRAGMA foreign_key_list(${t})`))
      fks.push({ from: t, to: f.table });
  return { tables, fks };
}

async function migratedStores() {
  const out = {} as Record<Store, SqlDriver>;
  for (const st of D1_STORES) {
    out[st] = sqliteDriver(":memory:");
    await migrate(out[st], loadMigrations(migrationsDirFor(st)));
  }
  out.local = sqliteDriver(":memory:");
  await out.local.batch(LOCAL_RUNTIME_SCHEMA.map((sql) => ({ sql })));
  await out.core.batch(RUN_STORE_SCHEMA.map((sql) => ({ sql }))); // beside core in tests
  return out;
}

describe("placement (data layer plan, step 2)", () => {
  it("every table is in exactly one store, and the map lists nothing that doesn't exist", async () => {
    const stores = await migratedStores();
    const seen = new Map<string, Store>();
    for (const [st, d] of Object.entries(stores) as [Store, SqlDriver][])
      for (const t of (await schemaOf(d)).tables) {
        expect(seen.has(t), `${t} is in ${seen.get(t)} and ${st}`).toBe(false);
        seen.set(t, st);
        expect(PLACEMENT[t], t).toBe(st);
      }
    expect([...seen.keys()].sort()).toEqual(Object.keys(PLACEMENT).sort());
  });

  it("no foreign key crosses a store", async () => {
    const stores = await migratedStores();
    for (const [st, d] of Object.entries(stores) as [Store, SqlDriver][])
      for (const fk of (await schemaOf(d)).fks)
        expect(PLACEMENT[fk.to], `${st}: ${fk.from} → ${fk.to}`).toBe(st);
  });

  it("no SQL string in the storage package touches two stores", () => {
    const dir = join(import.meta.dirname, "..");
    let scanned = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/(["`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
        const sql = m[2] as string;
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(sql) || !/\b(FROM|INTO|UPDATE)\b/.test(sql))
          continue;
        scanned++;
        expect(() => storeOf(sql), `${f}: ${sql.slice(0, 80)}`).not.toThrow();
      }
    }
    expect(scanned).toBeGreaterThan(300);
  });

  it("routes by table, and refuses a statement or a batch that spans two stores", async () => {
    expect(
      tablesIn("SELECT * FROM claims c JOIN verified_facts f ON f.entity_id = c.entity_id"),
    ).toEqual(["claims", "verified_facts"]);
    expect(storeOf("SELECT * FROM run_log WHERE task_id = ?")).toBe("telemetry");
    expect(storeOf("PRAGMA foreign_keys")).toBe("core");
    expect(() => storeOf("SELECT * FROM run_log JOIN tasks USING (task_id)")).toThrow(
      CrossStoreError,
    );
    const s = await migratedStores();
    const r = routedDriver({ core: s.core, facts: s.facts, telemetry: s.telemetry });
    await expect(
      r.batch([{ sql: "DELETE FROM tasks" }, { sql: "DELETE FROM run_log" }]),
    ).rejects.toThrow(CrossStoreError);
  });

  it("the append-only triggers still refuse UPDATE and DELETE in their new homes", async () => {
    const s = await migratedStores();
    const triggers = async (d: SqlDriver) =>
      (
        await d.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
        )
      ).map((r) => r.name);
    expect(await triggers(s.facts)).toEqual(["claims_no_delete", "claims_no_update"]);
    expect(await triggers(s.core)).toEqual(
      ["cost_events", "idea_thread", "pool_events", "revenue_events"].flatMap((t) => [
        `${t}_no_delete`,
        `${t}_no_update`,
      ]),
    );
    // Word for word the triggers the single database had (their behaviour is tested in the storage
    // suite on SQLite and D1, now running on the split stores).
    const single = sqliteDriver(":memory:");
    await migrate(
      single,
      loadMigrations(migrationsDirFor("core")).filter((m) => m.name < "0026"),
    );
    const sqlOf = (d: SqlDriver) =>
      d.all<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      );
    expect(
      [...(await sqlOf(s.core)), ...(await sqlOf(s.facts))].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ).toEqual(await sqlOf(single));
  });

  it("the split migration runs up, down and up again, back to exactly the same schema", async () => {
    const n = "0026_split.sql";
    const all = loadMigrations(migrationsDirFor("core")).filter((m) => m.name <= n);
    const before = sqliteDriver(":memory:");
    await migrate(
      before,
      all.filter((m) => m.name < n),
    );
    const db = sqliteDriver(":memory:");
    await migrate(db, all);
    const snap = async (d: SqlDriver) =>
      d.all(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name <> 'sqlite_sequence' ORDER BY type, name",
      );
    const up = await snap(db);
    await rollback(
      db,
      all.find((m) => m.name === n) as never,
      loadDownMigrations().get(n) as string,
    );
    expect(await snap(db)).toEqual(await snap(before));
    expect(await migrate(db, all)).toEqual([n]);
    expect(await snap(db)).toEqual(up);
  });
});

describe("data layer migrations run up, down and up again", () => {
  it.each([
    ["core", "0027_bodies.sql"],
    ["telemetry", "0002_bodies.sql"],
    ["core", "0028_daily_rollups.sql"],
    ["core", "0029_indexes.sql"],
    ["core", "0030_effect_args.sql"],
    ["facts", "0003_page_cuts.sql"],
    ["facts", "0002_indexes.sql"],
    ["telemetry", "0003_indexes.sql"],
  ] as const)("%s %s", async (store, n) => {
    const all = loadMigrations(migrationsDirFor(store)).filter((m) => m.name <= n);
    const before = sqliteDriver(":memory:");
    await migrate(
      before,
      all.filter((m) => m.name !== n),
    );
    const db = sqliteDriver(":memory:");
    await migrate(db, all);
    const snap = (d: SqlDriver) =>
      d.all(
        "SELECT type, name, sql FROM sqlite_master WHERE name <> 'sqlite_sequence' ORDER BY type, name",
      );
    const up = await snap(db);
    await rollback(
      db,
      all.find((m) => m.name === n) as never,
      loadDownMigrations(migrationsDownDirFor(store)).get(n) as string,
    );
    expect(await snap(db)).toEqual(await snap(before));
    expect(await migrate(db, all)).toEqual([n]);
    expect(await snap(db)).toEqual(up);
  });
});

describe("the index audit (step 6) keeps every row", () => {
  it("WITHOUT ROWID rebuilds copy the rows across, and entity_ref matches the old LIKE", async () => {
    const facts = sqliteDriver(":memory:");
    const fm = loadMigrations(migrationsDirFor("facts"));
    await migrate(
      facts,
      fm.filter((m) => m.name < "0002"),
    );
    await facts.run(
      "INSERT INTO drift_metrics (day, source, field, volume, null_rate, match_rate) VALUES ('2026-11-26', 'ch', 'f', 3, 0, 1)",
    );
    await migrate(facts, fm);
    expect(await facts.all("SELECT day, volume FROM drift_metrics")).toEqual([
      { day: "2026-11-26", volume: 3 },
    ]);
    const tel = sqliteDriver(":memory:");
    const tm = loadMigrations(migrationsDirFor("telemetry"));
    await migrate(
      tel,
      tm.filter((m) => m.name < "0003"),
    );
    await tel.run("INSERT INTO trigger_stats (day, rule_id, seen) VALUES ('2026-11-26', 'r', 7)");
    await migrate(tel, tm);
    expect(await tel.all("SELECT seen FROM trigger_stats")).toEqual([{ seen: 7 }]);
    const core = sqliteDriver(":memory:");
    await migrate(core, loadMigrations(migrationsDirFor("core")));
    const refs = [
      "opportunity:o1:entity:01234567",
      "entity:01234567",
      "card:c:entity:7",
      "batch:b",
    ];
    for (const [i, ref] of refs.entries())
      await core.run(
        "INSERT INTO tasks (task_id, idempotency_key, playbook, playbook_version, revenue_path, source_ref, lane, autonomy, status, budget_gbp, priority, created_at, updated_at) VALUES (?, ?, 'p', 1, 'r', ?, 'open', 'L0', 'queued', 1, 'normal', '2026-11-26', '2026-11-26')",
        [`t${i}`, `k${i}`, ref],
      );
    for (const id of ["01234567", "7"])
      expect(
        await core.all("SELECT task_id FROM tasks WHERE entity_ref = ? ORDER BY task_id", [id]),
      ).toEqual(
        await core.all("SELECT task_id FROM tasks WHERE source_ref LIKE ? ORDER BY task_id", [
          `%:entity:${id}`,
        ]),
      );
  });
});

describe("splitting an existing local database", () => {
  it("copies every moved table's rows into its new file before the split drops them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-split-"));
    const path = join(dir, "dev.sqlite");
    // A database as it was before the split (migrations up to 0025), with real rows.
    const old = sqliteDriver(path);
    await migrate(
      old,
      loadMigrations(migrationsDirFor("core")).filter((m) => m.name < "0026"),
    );
    await old.run(
      "INSERT INTO runs (run_id, kind, started_at, status, config_versions) VALUES ('r1', 'ingest', '2026-11-01T00:00:00Z', 'succeeded', '{}')",
    );
    await old.run(
      "INSERT INTO tasks (task_id, idempotency_key, playbook, playbook_version, revenue_path, source_ref, lane, autonomy, status, budget_gbp, revenue_gbp, cost_gbp, priority, state, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'k1', 'sme_outreach', 1, 'sme_outreach', 'entity:1', 'open', 'L0', 'queued', 1, 0, 0, 'normal', '{}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
    );
    await old.run(
      "INSERT INTO run_log (task_id, step_id, role, model, tool_calls, output, tokens_in, tokens_out, cost_gbp, duration_ms, timestamp) VALUES ('11111111-1111-4111-8111-111111111111', 's', 'writer', null, '[]', 'null', 0, 0, 0, 1, '2026-11-01T00:00:00Z')",
    );
    await old.run(
      "INSERT INTO workflow_instances (id, workflow, playbook, params, status, dry_run, created_at, updated_at) VALUES ('w1', 'claim_fulfilment', 'claim_site', '{}', 'running', 1, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')",
    );
    await old.run(
      "INSERT INTO workflow_steps (instance_id, name, output, completed_at) VALUES ('w1', 'step one', 'null', '2026-11-01T00:00:00Z')",
    );
    await old.close();

    const s = await openSqliteStorage(path);
    expect((await s.runs.get("r1"))?.status).toBe("succeeded");
    expect(await s.runLog.forTask("11111111-1111-4111-8111-111111111111")).toHaveLength(1);
    expect(await s.workflows.step("w1", "step one")).toBeTruthy();
    expect((await s.health()).databases).toEqual({
      core: loadMigrations(migrationsDirFor("core")).length,
      facts: loadMigrations(migrationsDirFor("facts")).length,
      telemetry: loadMigrations(migrationsDirFor("telemetry")).length,
    });
    await s.close();
    const core = new Database(storePaths(path).core);
    const left = core
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('runs', 'run_log', 'workflow_steps')")
      .all();
    core.close();
    expect(left).toEqual([]);
    // Opening again is a no-op (nothing copied twice).
    const again = await openSqliteStorage(path);
    expect(await again.runLog.forTask("11111111-1111-4111-8111-111111111111")).toHaveLength(1);
    await again.close();
  });
});
