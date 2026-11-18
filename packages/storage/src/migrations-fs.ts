import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration } from "./migrate.ts";

/** Node only. Absolute path of the migrations folder (also used by wrangler.jsonc). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** Node only. Down files for migrations 0020 onwards; never deployed (wrangler reads MIGRATIONS_DIR only). */
export const MIGRATIONS_DOWN_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations-down",
);

export function loadDownMigrations(dir: string = MIGRATIONS_DOWN_DIR): Map<string, string> {
  return new Map(
    readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );
}
