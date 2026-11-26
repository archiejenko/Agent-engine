import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migrate.ts";
import type { D1Store } from "./placement.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Node only. One migrations folder per D1 database (also named in wrangler.jsonc). */
export const migrationsDirFor = (store: D1Store) => join(HERE, "..", "migrations", store);
/** The core database's folder (the original 0001-… history). */
export const MIGRATIONS_DIR = migrationsDirFor("core");

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Node only. Down files for migrations 0020 onwards; never deployed (wrangler reads MIGRATIONS_DIR only). */
export const migrationsDownDirFor = (store: D1Store) => join(HERE, "..", "migrations-down", store);
export const MIGRATIONS_DOWN_DIR = migrationsDownDirFor("core");

export function loadDownMigrations(dir: string = MIGRATIONS_DOWN_DIR): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}
