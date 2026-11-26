import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
import { LOCAL_RUNTIME_SCHEMA } from "./local-runtime.ts";
import { migrate } from "./migrate.ts";
import { loadMigrations, migrationsDirFor } from "./migrations-fs.ts";
import { MOVED_OUT_OF_CORE, PLACEMENT, routedDriver } from "./placement.ts";
import { SqlStorage } from "./sql-storage.ts";

/** Node only. Local SQLite file (or ":memory:" for tests). */
export function sqliteDriver(path: string): SqlDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return {
    dialect: "sqlite",
    async all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlValue[] = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: r.changes };
    },
    async batch(statements: SqlStatement[]) {
      const tx = db.transaction((stmts: SqlStatement[]) => {
        for (const s of stmts) db.prepare(s.sql).run(...(s.params ?? []));
      });
      tx(statements);
    },
    async close() {
      db.close();
    },
  };
}

/**
 * The local files for one database path (data layer plan, step 2): `dev.sqlite` is core, beside it
 * `dev-facts.sqlite`, `dev-telemetry.sqlite` and the local-only `dev-runtime.sqlite`. ":memory:" → all
 * in memory.
 */
export function storePaths(path: string) {
  if (path === ":memory:")
    return { core: path, facts: path, telemetry: path, local: path } as const;
  const base = path.replace(/\.sqlite$/, "");
  return {
    core: path,
    facts: `${base}-facts.sqlite`,
    telemetry: `${base}-telemetry.sqlite`,
    local: `${base}-runtime.sqlite`,
  } as const;
}

const SPLIT = "0026_split.sql";

/**
 * Before the split migration drops the moved tables from an existing local database, copy their rows
 * into their new files, so nothing ingested locally (Companies House facts, the run log) is lost.
 * Graph run state (graph_node_runs, graph_state_values) isn't copied: it moved to the run store in step 1.
 */
async function copyMovedTables(paths: ReturnType<typeof storePaths>) {
  if (paths.core === ":memory:" || !existsSync(paths.core)) return;
  const db = new Database(paths.core);
  try {
    const has = (t: string) =>
      !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!has("d1_migrations") || !has("claims")) return;
    if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(SPLIT)) return;
    for (const store of ["facts", "telemetry"] as const) {
      const d = sqliteDriver(paths[store]);
      await migrate(d, loadMigrations(migrationsDirFor(store)));
      await d.close();
    }
    const local = sqliteDriver(paths.local);
    await local.batch(LOCAL_RUNTIME_SCHEMA.map((sql) => ({ sql })));
    await local.close();
    for (const store of ["facts", "telemetry", "local"] as const)
      db.prepare(`ATTACH DATABASE ? AS ${store}`).run(paths[store]);
    db.transaction(() => {
      for (const t of MOVED_OUT_OF_CORE) {
        if (!has(t)) continue;
        const to = PLACEMENT[t] as "facts" | "telemetry" | "local";
        db.prepare(`DELETE FROM ${to}.${t}`).run();
        db.prepare(`INSERT INTO ${to}.${t} SELECT * FROM main.${t}`).run();
      }
    })();
  } finally {
    db.close();
  }
}

/** Open (and migrate) a SQLite-backed Storage: the three databases plus the local runtime file. */
export async function openSqliteStorage(path: string): Promise<SqlStorage> {
  const paths = storePaths(path);
  await copyMovedTables(paths);
  const core = sqliteDriver(paths.core);
  const facts = sqliteDriver(paths.facts);
  const telemetry = sqliteDriver(paths.telemetry);
  const local = sqliteDriver(paths.local);
  await migrate(facts, loadMigrations(migrationsDirFor("facts")));
  await migrate(telemetry, loadMigrations(migrationsDirFor("telemetry")));
  await migrate(core, loadMigrations(migrationsDirFor("core")));
  await local.batch(LOCAL_RUNTIME_SCHEMA.map((sql) => ({ sql })));
  return new SqlStorage(routedDriver({ core, facts, telemetry, local }));
}
