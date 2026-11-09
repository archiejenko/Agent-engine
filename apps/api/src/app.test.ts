import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireAccess } from "./access.ts";
import { createApp } from "./app.ts";

let storage: Storage;
beforeAll(async () => {
  storage = await openSqliteStorage(":memory:");
});
afterAll(async () => {
  await storage.close();
});

describe("GET /api/health", () => {
  it("reports ok with the migration count", async () => {
    const app = createApp({ runtime: "node", storage: () => storage });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.storage).toEqual({ ok: true, migrations: 7 });
  });

  it("returns 503 when storage is unhealthy", async () => {
    const broken = { ...storage, health: async () => ({ ok: false, migrations: 0 }) } as Storage;
    const app = createApp({ runtime: "node", storage: () => broken });
    expect((await app.request("/api/health")).status).toBe(503);
  });

  it("unknown routes are JSON 404s", async () => {
    const app = createApp({ runtime: "node", storage: () => storage });
    expect((await app.request("/api/nope")).status).toBe(404);
  });
});

describe("facts API (read-only)", () => {
  const RUN = "facts-test";
  beforeAll(async () => {
    const run = await storage.runs.start({ kind: RUN });
    const claimId = "6f1c2a4e-1d2b-4e3f-8a9b-0c1d2e3f4a5b";
    await storage.entities.upsertMany(
      [
        {
          entity_id: "01234567",
          name: "ACME WIDGETS LTD",
          name_normalised: "ACME WIDGETS",
          postcode: "M1 1AA",
          lad_code: "E08000003",
          company_status: "active",
          accounts_category: "micro-entity",
          sic_codes: ["62012"],
          charges_count: 0,
          incorporation_date: "2015-03-02",
        },
      ],
      run.run_id,
    );
    await storage.claims.insertMany([
      {
        claim_id: claimId,
        entity_id: "01234567",
        raw_entity_ref: { source_id: "01234567", name: "ACME WIDGETS LTD" },
        field: "company_status",
        value: "active",
        source: "companies_house",
        source_tier: 1,
        lane: "open",
        method: "api",
        evidence: {
          kind: "record",
          ref: "https://api.company-information.service.gov.uk/company/01234567",
        },
        observed_at: "2026-11-07T09:00:00Z",
        published_at: "2015-03-02T00:00:00Z",
        fetched_at: "2026-11-07T09:00:00Z",
        run_id: run.run_id,
      },
    ]);
    await storage.facts.put(
      {
        entity_id: "01234567",
        field: "company_status",
        value: "active",
        confidence: 0.95,
        supporting_claims: [claimId],
        conflicting_claims: [],
        lane: "open",
        valid_from: "2015-03-02T00:00:00Z",
        first_observed_at: "2026-11-07T09:00:00Z",
        last_verified_at: "2026-11-07T09:00:00Z",
        expires_at: "2026-11-14T09:00:00Z",
        status: "verified",
      },
      { run_id: run.run_id, recorded_at: "2026-11-07T09:00:00Z" },
    );
  });
  const app = () => createApp({ runtime: "node", storage: () => storage });

  it("lists facts with search by name or number", async () => {
    const byName = (await (await app().request("/api/facts?search=acme")).json()) as {
      total: number;
    };
    expect(byName.total).toBe(1);
    const byNumber = (await (await app().request("/api/facts?search=01234567")).json()) as {
      total: number;
    };
    expect(byNumber.total).toBe(1);
    const none = (await (await app().request("/api/facts?search=zzz")).json()) as { total: number };
    expect(none.total).toBe(0);
  });

  it("validates query parameters", async () => {
    expect((await app().request("/api/facts?limit=5000")).status).toBe(400);
    expect((await app().request("/api/facts?status=nonsense")).status).toBe(400);
  });

  it("shows a company's facts with the claims and evidence behind them", async () => {
    const res = await app().request("/api/companies/01234567");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      facts: { supporting_claims: string[] }[];
      claims: Record<string, { evidence: unknown }>;
    };
    const id = body.facts[0]?.supporting_claims[0] as string;
    expect(body.claims[id]?.evidence).toEqual({
      kind: "record",
      ref: "https://api.company-information.service.gov.uk/company/01234567",
    });
    expect((await app().request("/api/companies/99999999")).status).toBe(404);
    expect((await app().request("/api/companies/bad")).status).toBe(400);
  });

  it("overview reports universe and fact counts", async () => {
    const body = (await (await app().request("/api/overview")).json()) as {
      facts: Record<string, number>;
      universe: { region: string };
    };
    expect(body.facts).toEqual({ verified: 1 });
    expect(body.universe.region).toBe("Greater Manchester");
  });
});

describe("Cloudflare Access check", () => {
  const TEAM = "https://ejtech.cloudflareaccess.com";
  const AUD = "test-aud-tag";
  let sign: (claims: { aud?: string; iss?: string; expSeconds?: number }) => Promise<string>;
  let jwks: ReturnType<typeof createLocalJWKSet>;
  let forge: () => Promise<string>;

  beforeAll(async () => {
    const real = await generateKeyPair("RS256");
    const fake = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(real.publicKey)), kid: "k1", alg: "RS256" };
    jwks = createLocalJWKSet({ keys: [jwk] });
    sign = async ({ aud = AUD, iss = TEAM, expSeconds = 300 }) =>
      new SignJWT({ email: "archie@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
        .sign(real.privateKey);
    forge = async () =>
      new SignJWT({ email: "attacker@example.com" })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(TEAM)
        .setAudience(AUD)
        .setExpirationTime("5m")
        .sign(fake.privateKey);
  });

  const appWith = (teamDomain: string | undefined, policyAud: string | undefined) =>
    createApp({
      runtime: "worker",
      storage: () => storage,
      auth: requireAccess({ teamDomain, policyAud, jwks }),
    });

  const get = (app: ReturnType<typeof appWith>, token?: string) =>
    app.request("/api/health", token ? { headers: { "cf-access-jwt-assertion": token } } : {});

  it("fails closed when Access is not configured", async () => {
    const res = await get(appWith("", ""), await sign({}));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access_not_configured" });
  });

  it("refuses requests without a token", async () => {
    expect((await get(appWith(TEAM, AUD))).status).toBe(403);
  });

  it("refuses a token signed by someone else", async () => {
    expect((await get(appWith(TEAM, AUD), await forge())).status).toBe(403);
  });

  it("refuses wrong audience, wrong issuer and expired tokens", async () => {
    const app = appWith(TEAM, AUD);
    expect((await get(app, await sign({ aud: "other-app" }))).status).toBe(403);
    expect((await get(app, await sign({ iss: "https://evil.cloudflareaccess.com" }))).status).toBe(
      403,
    );
    expect((await get(app, await sign({ expSeconds: -60 }))).status).toBe(403);
  });

  it("allows a valid Access token", async () => {
    expect((await get(appWith(TEAM, AUD), await sign({}))).status).toBe(200);
  });
});
