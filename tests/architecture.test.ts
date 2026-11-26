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
  // Scoring, targeting, learning, ledger and verification code: none of it may read the seeded ideas,
  // their hypotheses or their score history.
  const scoring = files.filter(
    (f) =>
      !/\.test\.ts$|__tests__/.test(f) &&
      (/^packages\/(opportunity|verification)\/src\//.test(f) ||
        /^packages\/infra\/src\/(ev|cohort|ledger|lift|analytics|economics|autonomy|budget|outreach|triggers|digest|crm)\.ts$/.test(
          f,
        )),
  );
  it("scoring, targeting and learning code never reads the seeded ideas sheet or hypotheses", () => {
    const offenders = scoring.filter((f) =>
      /seed-500|brain\/ideas|\bhypotheses\b|hypothesis_score_history|hypothesis_imports|ideaScore|importIdeas|ideasSheetView|from "\.\/ideas\.ts"/.test(
        readFileSync(join(ROOT, f), "utf8"),
      ),
    );
    expect(scoring.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
  it("no SQL outside the hypotheses store touches the hypotheses tables", () => {
    const sqlFiles = files.filter(
      (f) => /^packages\/storage\/src\/.*\.ts$/.test(f) && !/\.test\.ts$/.test(f),
    );
    const outside = sqlFiles.filter(
      (f) =>
        f !== "packages/storage/src/v3.ts" &&
        f !== "packages/storage/src/sql-storage.ts" &&
        f !== "packages/storage/src/placement.ts" &&
        /\bhypotheses\b|hypothesis_score_history|hypothesis_imports/.test(
          readFileSync(join(ROOT, f), "utf8"),
        ),
    );
    expect(outside).toEqual([]);
    const v3 = readFileSync(join(ROOT, "packages/storage/src/v3.ts"), "utf8");
    const start = v3.indexOf("    hypotheses: {");
    const end = v3.indexOf("    keyRegistry: {");
    const strays = [
      ...v3.matchAll(/(FROM|INTO|JOIN|UPDATE)\s+(hypotheses|hypothesis_\w+)/g),
    ].filter((m) => (m.index ?? 0) < start || (m.index ?? 0) > end);
    expect(start).toBeGreaterThan(0);
    expect(strays.map((m) => m[0])).toEqual([]);
  });
});

describe("v3 rule 20: keys are write-only and read in one place", () => {
  const src = files.filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$|__tests__/.test(f));
  it("only packages/infra/src/keys.ts calls KeyStore.reveal (the tool registry's injection point)", () => {
    const callers = src.filter(
      (f) =>
        f !== "packages/ports/src/keys.ts" &&
        /\.reveal\(/.test(readFileSync(join(ROOT, f), "utf8")),
    );
    expect(callers).toEqual(["packages/infra/src/keys.ts"]);
  });
  it("Worker code never reads a catalogue key straight from its environment", () => {
    const names = (
      JSON.parse(readFileSync(join(ROOT, "packages/config/src/keys.json"), "utf8")) as {
        keys: { name: string }[];
      }
    ).keys.map((k) => k.name);
    const offenders = src
      .filter((f) => f.startsWith("apps/api/src/"))
      .flatMap((f) => {
        const t = readFileSync(join(ROOT, f), "utf8");
        return names
          .filter((n) => new RegExp(`(vars|env)\\)?\\.${n}\\b`).test(t))
          .map((n) => `${f}: ${n}`);
      });
    expect(offenders).toEqual([]);
  });
  it("the key registry table has no value column", () => {
    const sql = readFileSync(
      join(ROOT, "packages/storage/migrations/core/0017_v3_keys.sql"),
      "utf8",
    );
    expect(/\bvalue\b|ciphertext/i.test(sql.replace(/--.*$/gm, ""))).toBe(false);
  });
});

describe("planner eval isolation (rule 13: the proposer never grades itself)", () => {
  it("the planner's code can't read or write the eval set", () => {
    for (const f of ["apps/agent-runner/src/planner.ts", "apps/agent-runner/src/fake-planner.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src, f).not.toMatch(/evals\//);
      expect(src, f).not.toMatch(/node:fs|from "fs"/);
    }
  });
});
