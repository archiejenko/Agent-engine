import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Builds the real Worker bundle with Wrangler (what `wrangler deploy` would upload) and runs it in
 * Miniflare with a D1 database. Catches deployment problems before deploying.
 */
const API = join(import.meta.dirname, "..", "apps", "api");
const MIGRATIONS = join(import.meta.dirname, "..", "packages", "storage", "migrations");

let mf: Miniflare;

beforeAll(async () => {
  mkdirSync(join(API, "..", "dashboard", "dist"), { recursive: true });
  const out = mkdtempSync(join(tmpdir(), "ae-worker-"));
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], {
    cwd: API,
    stdio: "pipe",
  });
  const script = readdirSync(out).find((f) => f.endsWith(".js"));
  if (!script) throw new Error("wrangler produced no bundle");
  mf = new Miniflare({
    // Load the bundle by contents (its source-map paths point outside the folder, which the local
    // runtime refuses to follow).
    modules: [
      {
        type: "ESModule",
        path: "worker.js",
        contents: readFileSync(join(out, script), "utf8").replace(
          /\/\/# sourceMappingURL=.*$/m,
          "",
        ),
      },
    ],
    compatibilityDate: "2026-08-01",
    d1Databases: ["DB"],
    bindings: { ACCESS_TEAM_DOMAIN: "", ACCESS_POLICY_AUD: "" },
  });
  // Apply the same migrations wrangler would apply to the remote database.
  const { migrate } = await import("@ae/storage");
  const { loadMigrations } = await import("@ae/storage/migrations-fs");
  const { d1Driver } = await import("@ae/storage");
  await migrate(d1Driver(await mf.getD1Database("DB")), loadMigrations(MIGRATIONS));
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

describe("deployed Worker bundle", () => {
  it("refuses /api requests when Access is not configured (fails closed)", async () => {
    const res = await mf.dispatchFetch("http://localhost/api/health");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access_not_configured" });
  });

  it("refuses /api requests with a junk token", async () => {
    const res = await mf.dispatchFetch("http://localhost/api/health", {
      headers: { "cf-access-jwt-assertion": "not-a-jwt" },
    });
    expect(res.status).toBe(403);
  });
});
