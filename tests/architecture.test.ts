import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (["node_modules", "dist", ".wrangler"].includes(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const files = [
  ...walk(join(ROOT, "apps")),
  ...walk(join(ROOT, "packages")),
  ...walk(join(ROOT, "scripts")),
]
  .map((p) => relative(ROOT, p))
  .filter((p) => !p.endsWith("worker-configuration.d.ts"));

/**
 * CLAUDE.md rule: no engine code may import the database directly. Only the storage package and the
 * composition roots (the files that wire an app together) may touch a database adapter.
 */
const ADAPTER_ALLOWED = [
  /^packages\/storage\//,
  /^apps\/api\/src\/node\.ts$/,
  /^apps\/api\/src\/worker\.ts$/,
  /^apps\/api\/src\/app\.test\.ts$/,
  /^scripts\//,
];

const DB_PATTERNS: [string, RegExp][] = [
  ["better-sqlite3", /from\s+["']better-sqlite3["']/],
  ["D1Database", /\bD1Database\b/],
  ["storage adapters", /from\s+["']@ae\/storage\/(sqlite|migrations-fs)["']/],
  ["createD1Storage / d1Driver", /\b(createD1Storage|d1Driver|sqliteDriver)\b/],
];

describe("architecture: database access only through the Storage interface", () => {
  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const [label, pattern] of DB_PATTERNS) {
    it(`no ${label} outside storage and composition roots`, () => {
      const offenders = files.filter(
        (f) =>
          !ADAPTER_ALLOWED.some((a) => a.test(f)) &&
          pattern.test(readFileSync(join(ROOT, f), "utf8")),
      );
      expect(offenders).toEqual([]);
    });
  }

  it("the Worker-safe storage entry does not pull in Node-only modules", () => {
    const entry = readFileSync(join(ROOT, "packages/storage/src/index.ts"), "utf8");
    expect(entry).not.toMatch(/sqlite\.ts|migrations-fs\.ts|node:/);
  });
});
