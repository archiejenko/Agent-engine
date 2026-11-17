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
  // The Worker's runtime entry (cron, queue consumer, Durable Object, Workflow): a composition root.
  /^apps\/api\/src\/runtime-worker\.ts$/,
  /^apps\/api\/src\/app\.test\.ts$/,
  /^apps\/agent-runner\/src\/main\.ts$/,
  /^apps\/[a-z-]+\/src\/.*\.test\.ts$/,
  /^apps\/api\/src\/gates\//,
  // Tests wire their own storage (like a composition root); engine source files may not.
  /^packages\/[a-z-]+\/src\/__tests__\//,
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

/**
 * v2 rule 14: agents can never change the safety layer. Code that agents run (playbook roles and the
 * tools they call) may not touch kill switches, spend caps or tiers, autonomy, queue pausing or owner
 * approvals. Only Archie's dashboard routes and the runner's own guardrails do that.
 */
const AGENT_FACING = [
  /^packages\/infra\/src\/playbooks\//,
  /^packages\/infra\/src\/outreach\.ts$/,
  /^packages\/infra\/src\/standard-tools\.ts$/,
  /^packages\/products\/src\/product-playbooks\.ts$/,
  /^playbooks\//,
];
const SAFETY_WRITES =
  /\b(setKillSwitch|setSpendTier|promotePlaybook|ownerApprovals|controls\.set|K\.(global|queuePaused|spendTier|autonomy|playbook))\b/;

describe("v2 rule 14: agents can't change the safety layer", () => {
  it("agent-facing code never writes kill switches, caps, tiers, autonomy or approvals", () => {
    const agentFiles = files.filter(
      (f) => AGENT_FACING.some((a) => a.test(f)) && !f.includes("__tests__"),
    );
    expect(agentFiles.length).toBeGreaterThan(3);
    const offenders = agentFiles.filter((f) =>
      SAFETY_WRITES.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("owner approvals are created only by the decisions path (v3 rule 18)", () => {
    const creators = files.filter(
      (f) =>
        /ownerApprovals\.add\(/.test(readFileSync(join(ROOT, f), "utf8")) &&
        !/(\.test\.ts$|__tests__|\/gates\/)/.test(f),
    );
    expect(creators).toEqual(["packages/infra/src/decisions.ts"]);
  });
});

describe("v3 rule 23: assumed numbers stay assumed", () => {
  it("scoring, targeting and learning code never reads the seeded ideas sheet", () => {
    const scoring = files.filter(
      (f) =>
        /^packages\/opportunity\/src\//.test(f) ||
        /^packages\/infra\/src\/(ev|cohort|ledger|lift|analytics)\.ts$/.test(f),
    );
    const offenders = scoring.filter((f) =>
      /seed-500|parseIdeasSheet|brain\/ideas/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(scoring.length).toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
