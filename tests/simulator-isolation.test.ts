import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { stripComments } from "./cockpit-static.helpers.ts";

/**
 * Archie, U2 gate: prove the simulator and rehearsal loaders cannot write to the production D1
 * databases (agent-engine, agent-engine-facts, agent-engine-telemetry).
 *
 * The only way to reach those databases is a D1 binding inside the deployed Worker (no script holds
 * credentials or an HTTP driver for them). So the proof has two halves:
 *   1. nothing that writes simulated data is in the Worker bundle (`wrangler deploy --dry-run` output);
 *   2. the loaders themselves only open local SQLite files and never name a production database.
 */
const ROOT = resolve(import.meta.dirname, "..");
const PROD_DBS = ["agent-engine", "agent-engine-facts", "agent-engine-telemetry"];

/** Code that writes simulated or rehearsal data. */
const LOADERS = [
  /^scripts\/rehearse\.ts$/,
  /^scripts\/gate-[\w-]+\.ts$/,
  /^scripts\/screens\//,
  /^scripts\/lib\.ts$/,
  // Main's extractor comparison (f58444d) runs models on generated fake websites.
  /^scripts\/compare-extractors\.ts$/,
  /^packages\/verification\/src\/node\//,
  /^apps\/api\/src\/gates\//,
  /^apps\/agent-runner\/src\/gates\//,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|cjs|mjs|js)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}
const code = ["apps", "packages", "scripts"]
  .flatMap((d) => walk(join(ROOT, d)))
  .filter((f) => !/\.test\.tsx?$|__tests__|\.generated\.ts$/.test(f));
const loaders = code.filter((f) => LOADERS.some((r) => r.test(f)));
const NAMES = new RegExp(`["'\`](${PROD_DBS.join("|")})["'\`]`);

/** Every way a file could reach a production D1 database. */
function problems(code: string): string[] {
  const out: string[] = [];
  if (/createD1Storage|d1Driver|D1Database/.test(code)) out.push("opens D1");
  if (/api\.cloudflare\.com/.test(code)) out.push("calls the Cloudflare API");
  if (/["'`]--remote["'`]|["'`]d1["'`]/.test(code))
    out.push("runs a wrangler d1 or --remote command");
  if (/["'`]wrangler["'`]/.test(code) && !/["'`]--dry-run["'`]/.test(code))
    out.push("runs wrangler for real (not --dry-run)");
  if (NAMES.test(code)) out.push("names a production database");
  return out;
}
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
/** Source without comments (a database named in a comment can't open it). */
const src = (f: string) => stripComments(read(f));

describe("the deployed Worker contains no simulator or rehearsal loader", () => {
  let inputs: string[] = [];
  let bundle = "";
  beforeAll(() => {
    const api = join(ROOT, "apps/api");
    mkdirSync(join(ROOT, "apps/dashboard/dist"), { recursive: true });
    const out = mkdtempSync(join(tmpdir(), "ae-isolation-"));
    execFileSync(
      "pnpm",
      [
        "exec",
        "wrangler",
        "deploy",
        "--dry-run",
        "--outdir",
        out,
        "--metafile",
        join(out, "meta.json"),
      ],
      { cwd: api, stdio: "pipe" },
    );
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as {
      inputs: Record<string, unknown>;
    };
    inputs = Object.keys(meta.inputs).map((p) => relative(ROOT, resolve(api, p)));
    bundle = readFileSync(
      join(out, readdirSync(out).find((f) => f.endsWith(".js")) as string),
      "utf8",
    );
  }, 180_000);

  it("reads the bundle's real file list (positive control)", () => {
    expect(inputs.length).toBeGreaterThan(200);
    expect(inputs).toContain("apps/api/src/runtime-worker.ts");
    expect(inputs).toContain("packages/storage/src/d1.ts");
  });

  it("no simulator, gate or rehearsal file is in the bundle", () => {
    expect(inputs.filter((f) => LOADERS.some((r) => r.test(f)))).toEqual([]);
    // Fake-data generators (companies, websites, the synthetic world) never ship. The pre-cutover fake
    // model's extractor does (website/fake-extractor.ts): it quotes real pages and invents nothing.
    expect(inputs.filter((f) => /synthetic-world|synthetic\.ts$/.test(f))).toEqual([]);
  });

  it("the bundle carries none of the simulator's data or markers", () => {
    expect(bundle).not.toContain("SYNTHETIC TRADING");
    expect(bundle).not.toMatch(/function generateSites\b|function buildSyntheticWorld\b/);
    expect(bundle).not.toContain("markTestWorldLeadsSimulated");
  });
});

describe("the loaders can only write local SQLite files", () => {
  it("finds the loaders (positive control)", () => {
    expect(loaders).toContain("scripts/rehearse.ts");
    expect(loaders).toContain("packages/verification/src/node/synthetic.ts");
    expect(loaders).toContain("apps/api/src/gates/test-world.ts");
    expect(loaders).toContain("scripts/compare-extractors.ts");
    expect(loaders.length).toBeGreaterThan(20);
  });

  it("no loader can open D1, call Cloudflare, or name a production database", () => {
    const hits = loaders.flatMap((f) => problems(src(f)).map((p) => `${f}: ${p}`));
    expect(hits).toEqual([]);
  });

  it("the detector catches D1 access (negative control)", () => {
    expect(/createD1Storage|d1Driver/.test("const s = createD1Storage({ core: env.DB })")).toBe(
      true,
    );
  });

  it("D1 storage is created in exactly one place: the deployed Worker's entry", () => {
    const callers = code.filter((f) => /createD1Storage\(/.test(read(f)));
    expect(callers.sort()).toEqual([
      "apps/api/src/runtime-worker.ts",
      "packages/storage/src/index.ts",
    ]);
  });

  it("the production database names appear only in the Worker's Wrangler config", () => {
    expect(code.filter((f) => NAMES.test(src(f)))).toEqual([]);
    expect(read("apps/api/wrangler.jsonc")).toMatch(/"database_name": "agent-engine-facts"/);
  });

  it("only the test world marks decisions simulated (a real decision must never be hidden)", () => {
    const callers = code.filter((f) => /decisions\.markSynthetic\(/.test(read(f)));
    expect(callers).toEqual(["apps/api/src/gates/test-world.ts"]);
  });
});
