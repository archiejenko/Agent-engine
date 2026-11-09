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
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: {
      ACCESS_TEAM_DOMAIN: "",
      ACCESS_POLICY_AUD: "",
      // A stand-in facilitator (answered below) so the official x402 middleware runs in workerd.
      X402_FACILITATOR_URL: "https://facilitator.test",
      X402_PAY_TO: "0x2222222222222222222222222222222222222222",
    },
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      if (url.host === "facilitator.test" && url.pathname.endsWith("/supported"))
        return Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }],
          extensions: [],
          signers: {},
        });
      return new Response("blocked in test", { status: 599 });
    },
  });
  // Apply the same migrations wrangler would apply to the remote database.
  const { migrate } = await import("@ae/storage");
  const { loadMigrations } = await import("@ae/storage/migrations-fs");
  const { d1Driver } = await import("@ae/storage");
  await migrate(d1Driver(await mf.getD1Database("DB")), loadMigrations(MIGRATIONS));
  const { createD1Storage } = await import("@ae/storage");
  const s = createD1Storage(await mf.getD1Database("DB"));
  const run = (await s.runs.start({ kind: "seed" })).run_id;
  await s.entities.upsertMany(
    [
      {
        entity_id: "01234567",
        name: "ACME WIDGETS LTD",
        name_normalised: "ACME WIDGETS",
        postcode: null,
        lad_code: null,
        company_status: "active",
        accounts_category: null,
        sic_codes: [],
        charges_count: null,
        incorporation_date: null,
      },
    ],
    run,
  );
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

  it("serves the x402 challenge through the official middleware (workerd, nodejs_compat)", async () => {
    const res = await mf.dispatchFetch("http://localhost/x402/check/01234567");
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const required = JSON.parse(atob(header as string)) as {
      x402Version: number;
      accepts: { network: string; payTo: string; amount: string }[];
    };
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]).toMatchObject({ network: "eip155:84532", amount: "50000" });
    // Unknown companies are free: no challenge.
    expect((await mf.dispatchFetch("http://localhost/x402/check/99999999")).status).toBe(404);
  });
});
