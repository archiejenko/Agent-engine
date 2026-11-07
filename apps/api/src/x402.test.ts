import type { Claim } from "@ae/contracts";
import {
  b64,
  FakeFacilitator,
  fakeAgentPayment,
  type PaymentRequirements,
  unb64,
} from "@ae/products";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { defaultContext, ingestClaims, stableUuid } from "@ae/verification";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const PAY_TO = "0x2222222222222222222222222222222222222222";
let storage: Storage;
let facilitator: FakeFacilitator;

async function seed(s: Storage) {
  const ctx = defaultContext();
  ctx.confidence = {
    ...ctx.confidence,
    sources: {
      ...ctx.confidence.sources,
      test_vendor: {
        tier: 4,
        upstream: "test_vendor",
        continuous: false,
        lane: "licensed",
        description: "test",
      },
    },
  };
  const run = (await s.runs.start({ kind: "seed" })).run_id;
  const now = new Date().toISOString();
  const c = async (
    field: string,
    value: Claim["value"],
    o: Partial<Claim> = {},
  ): Promise<Claim> => ({
    claim_id: await stableUuid([
      o.source ?? "companies_house",
      "01234567",
      field,
      JSON.stringify(value),
    ]),
    entity_id: "01234567",
    raw_entity_ref: { source_id: "01234567", name: null },
    field,
    value,
    source: "companies_house",
    source_tier: 1,
    lane: "open",
    method: "api",
    evidence: { kind: "record", ref: "test" },
    observed_at: now,
    published_at: now,
    fetched_at: now,
    run_id: run,
    ...o,
  });
  await ingestClaims(s, ctx, { run_id: run, fetched_at: now }, [
    await c("company_name", "ACME WIDGETS LTD"),
    await c("company_status", "liquidation"),
    await c("accounts_overdue", true),
    // Licensed vendor data must never be served to x402.
    await c("website_url", "secret-vendor.example", {
      source: "test_vendor",
      source_tier: 4,
      lane: "licensed",
    }),
  ]);
  await s.entities.upsertMany(
    [
      {
        entity_id: "01234567",
        name: "ACME WIDGETS LTD",
        name_normalised: "ACME WIDGETS",
        postcode: null,
        lad_code: null,
        company_status: "liquidation",
        accounts_category: null,
        sic_codes: [],
        charges_count: null,
        incorporation_date: null,
      },
    ],
    run,
  );
}

beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
  await seed(storage);
  facilitator = new FakeFacilitator();
});

const app = (refresh?: (n: string) => Promise<boolean>) =>
  createApp({
    runtime: "node",
    storage: () => storage,
    x402: { facilitator, payTo: PAY_TO, ...(refresh ? { refresh } : {}) },
  });

async function challenge(path = "/x402/check/01234567") {
  const res = await app().request(path);
  expect(res.status).toBe(402);
  const header = res.headers.get("PAYMENT-REQUIRED") as string;
  const required = unb64<{ accepts: PaymentRequirements[] }>(header);
  return required.accepts[0] as PaymentRequirements;
}

describe("x402 company check", () => {
  it("challenges with 402 and PAYMENT-REQUIRED (testnet USDC, our wallet, the tier price)", async () => {
    const r = await challenge();
    expect(r).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      payTo: PAY_TO,
      amount: "50000",
    });
    const premium = await challenge("/x402/check/01234567?tier=premium");
    expect(premium.amount).toBe("250000");
  });

  it("serves a paid check with per-field confidence and last_verified_at, and settles", async () => {
    const r = await challenge();
    const res = await app().request("/x402/check/01234567", {
      headers: { "PAYMENT-SIGNATURE": fakeAgentPayment(r) },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      fields: Record<string, { confidence: number; last_verified_at: string }>;
      risk_flags: { flag: string }[];
    };
    expect(body.fields.company_status?.confidence).toBeGreaterThan(0.9);
    expect(body.fields.company_status?.last_verified_at).toBeTruthy();
    expect(body.risk_flags.map((f) => f.flag)).toEqual(["not_active", "accounts_overdue"]);
    expect(unb64<{ success: boolean }>(res.headers.get("PAYMENT-RESPONSE") as string).success).toBe(
      true,
    );
    expect(facilitator.settled).toHaveLength(1);
    const logged = await storage.x402.since("2000-01-01");
    expect(logged.map((l) => l.status)).toEqual(["challenge", "served"]);
    expect(await storage.ledger.total("x402", "2000-01-01")).toBeGreaterThan(0);
  });

  it("GATE: licensed facts are never served to x402", async () => {
    const r = await challenge();
    const res = await app().request("/x402/check/01234567", {
      headers: { "PAYMENT-SIGNATURE": fakeAgentPayment(r) },
    });
    const body = (await res.json()) as { fields: Record<string, unknown> };
    expect(body.fields.website_url).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/secret-vendor/);
  });

  it("refuses forged, underpaid, misdirected and replayed payments", async () => {
    const r = await challenge();
    const forged = b64({
      x402Version: 2,
      accepted: r,
      payload: {
        signature: "made-up",
        authorization: { from: "0x1", value: r.amount, nonce: "n" },
      },
    });
    expect(
      (await app().request("/x402/check/01234567", { headers: { "PAYMENT-SIGNATURE": forged } }))
        .status,
    ).toBe(402);
    const low = fakeAgentPayment({ ...r, amount: "1" });
    expect(
      (await app().request("/x402/check/01234567", { headers: { "PAYMENT-SIGNATURE": low } }))
        .status,
    ).toBe(402);
    const wrongWallet = fakeAgentPayment({
      ...r,
      payTo: "0x3333333333333333333333333333333333333333",
    });
    expect(
      (
        await app().request("/x402/check/01234567", {
          headers: { "PAYMENT-SIGNATURE": wrongWallet },
        })
      ).status,
    ).toBe(402);
    const once = fakeAgentPayment(r, undefined, "nonce-1");
    expect(
      (await app().request("/x402/check/01234567", { headers: { "PAYMENT-SIGNATURE": once } }))
        .status,
    ).toBe(200);
    expect(
      (await app().request("/x402/check/01234567", { headers: { "PAYMENT-SIGNATURE": once } }))
        .status,
    ).toBe(402);
    expect(facilitator.settled).toHaveLength(1);
  });

  it("premium: if live re-verification fails, the agent isn't charged", async () => {
    const r = await challenge("/x402/check/01234567?tier=premium");
    const res = await app(async () => false).request("/x402/check/01234567?tier=premium", {
      headers: { "PAYMENT-SIGNATURE": fakeAgentPayment(r) },
    });
    expect(res.status).toBe(503);
    expect(facilitator.settled).toHaveLength(0);
    const ok = await app(async () => true).request("/x402/check/01234567?tier=premium", {
      headers: { "PAYMENT-SIGNATURE": fakeAgentPayment(r) },
    });
    expect(((await ok.json()) as { live_check: string }).live_check).toBe("refreshed");
  });

  it("unknown companies are free (404, no challenge) and the endpoint isn't behind /api auth", async () => {
    expect((await app().request("/x402/check/99999999")).status).toBe(404);
    const withAuth = createApp({
      runtime: "worker",
      storage: () => storage,
      auth: async (c) => c.json({ error: "blocked" }, 403),
      x402: { facilitator, payTo: PAY_TO },
    });
    expect((await withAuth.request("/x402/check/01234567")).status).toBe(402);
    expect((await withAuth.request("/api/health")).status).toBe(403);
  });
});
