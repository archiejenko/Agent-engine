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
    expect(body.storage).toEqual({ ok: true, migrations: 1 });
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
