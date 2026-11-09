import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyntheticWorld, fakeModel, type GateCriterion } from "@ae/agent-runner";
import { loadCompaniesHouseConfig, loadProductsConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
import { parseFramework, runModule } from "@ae/opportunity";
import {
  FakeFacilitator,
  fakeAgentPayment,
  liveRefresh,
  type PaymentRequirements,
  recordX402Interest,
  unb64,
} from "@ae/products";
import type { Storage } from "@ae/storage";
import {
  CompaniesHouseClient,
  consumeStream,
  FakeChangeStream,
  ingestClaims,
  runBlindVerifier,
  stableUuid,
  TokenBucket,
} from "@ae/verification";
import { syntheticChFetch } from "@ae/verification/node";
import { createApp } from "../app.ts";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
};

/**
 * Phase 4 gate (synthetic): paid end-to-end call (fake facilitator), licensed facts can't be served,
 * median response time and margin per call, blind verifier, stream consumer, x402_discovery fed.
 */
export async function runPhase4Gate(
  storage: Storage,
  root: string,
  o: { count: number; calls: number; premium: number; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  const world = await buildSyntheticWorld(storage, fakeModel(), { count: o.count, log });
  const ctx = world.ctx;
  const ch = loadCompaniesHouseConfig();
  const client = new CompaniesHouseClient({
    apiKey: "synthetic",
    config: ch,
    fetch: syntheticChFetch(world.set.companies),
    bucket: new TokenBucket(1_000_000, 1),
    sleep: async () => {},
  });
  const facilitator = new FakeFacilitator();
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    x402: {
      facilitator,
      payTo: "0x2222222222222222222222222222222222222222",
      refresh: (n) => liveRefresh(storage, ctx, client, ch, n),
    },
  });
  const members = (await storage.universe.list(world.universe.name, { included: true })).map(
    (m) => m.entity_id,
  );

  // 1. End-to-end paid call.
  const pay = async (n: string, tier: "cached" | "premium", agent: string) => {
    const path = `/x402/check/${n}${tier === "premium" ? "?tier=premium" : ""}`;
    const c = await app.request(path);
    if (c.status !== 402) return { status: c.status, body: null };
    const reqs = unb64<{ accepts: PaymentRequirements[] }>(
      c.headers.get("PAYMENT-REQUIRED") as string,
    ).accepts[0] as PaymentRequirements;
    const r = await app.request(path, {
      headers: { "PAYMENT-SIGNATURE": fakeAgentPayment(reqs, { from: agent }) },
    });
    return {
      status: r.status,
      body:
        r.status === 200
          ? ((await r.json()) as {
              fields: Record<string, { confidence: number; last_verified_at: string }>;
            })
          : null,
    };
  };
  const first = await pay(
    members[0] as string,
    "cached",
    "0xa000000000000000000000000000000000000001",
  );
  const e2eOk =
    first.status === 200 &&
    Object.values(first.body?.fields ?? {}).every(
      (f) => typeof f.confidence === "number" && f.last_verified_at,
    );

  // 2. Licensed facts can't be served: plant a licensed claim and look for it in the response.
  const target = members[1] as string;
  const run = (await storage.runs.start({ kind: "licensed_probe" })).run_id;
  const now = new Date().toISOString();
  const licensedCtx = {
    ...ctx,
    confidence: {
      ...ctx.confidence,
      sources: {
        ...ctx.confidence.sources,
        probe_vendor: {
          tier: 4,
          upstream: "probe_vendor",
          continuous: false,
          lane: "licensed" as const,
          description: "probe",
        },
      },
    },
  };
  const probe: Claim = {
    claim_id: await stableUuid(["probe_vendor", target, "website_url"]),
    entity_id: target,
    raw_entity_ref: { source_id: target, name: null },
    field: "website_url",
    value: "licensed-only.example",
    source: "probe_vendor",
    source_tier: 4,
    lane: "licensed",
    method: "api",
    evidence: { kind: "record", ref: "probe" },
    observed_at: now,
    published_at: now,
    fetched_at: now,
    run_id: run,
  };
  await ingestClaims(storage, licensedCtx, { run_id: run, fetched_at: now }, [probe]);
  const licensedResp = await pay(target, "cached", "0xa000000000000000000000000000000000000002");
  const leaked = JSON.stringify(licensedResp.body ?? {}).includes("licensed-only.example");

  // 3. Volume: cached and premium calls from several agents.
  for (let i = 0; i < o.calls; i++)
    await pay(
      members[i % members.length] as string,
      "cached",
      `0xb${String(i % 7).padStart(39, "0")}`,
    );
  for (let i = 0; i < o.premium; i++)
    await pay(
      members[(i * 3) % members.length] as string,
      "premium",
      `0xc${String(i % 5).padStart(39, "0")}`,
    );
  const served = (await storage.x402.since("2000-01-01")).filter((r) => r.status === "served");
  const byTier = (t: "cached" | "premium") => served.filter((r) => r.tier === t);
  const stats = (t: "cached" | "premium") => {
    const rows = byTier(t);
    const margin = rows.length
      ? rows.reduce((a, r) => a + r.price_gbp - r.cost_gbp, 0) / rows.length
      : 0;
    return {
      n: rows.length,
      median_ms: median(rows.map((r) => r.latency_ms)),
      margin_gbp: margin,
      price_gbp: rows[0]?.price_gbp ?? 0,
    };
  };
  const cached = stats("cached");
  const premium = stats("premium");

  // 4. Blind verifier (full sample for the gate), stream consumer, discovery module.
  const blind = await runBlindVerifier(
    storage,
    ctx,
    client,
    ch,
    { ...loadProductsConfig().blind_verifier, base_rate: 0.05 },
    { maxCompanies: 50 },
  );
  const stream = new FakeChangeStream(
    members.slice(0, 30).map((m, i) => ({
      stream: "officers" as const,
      timepoint: 100 + i,
      type: "changed",
      published_at: now,
      resource_uri: `/company/${m}/appointments/x`,
      company_number: m,
    })),
  );
  const streamed = await consumeStream(storage, stream, "officers");
  await recordX402Interest(storage, ctx);
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/x402_discovery.md"), "utf8"),
  );
  const disc = await runModule(storage, ctx, fw, { asOf: now });

  const criteria: GateCriterion[] = [
    {
      criterion:
        "End-to-end paid call (402 → pay → data with per-field confidence and last_verified_at)",
      status: e2eOk ? "passed (synthetic)" : "failed",
      evidence: `fake facilitator (dry run); ${facilitator.settled.length} payments settled to the fake ledger`,
    },
    {
      criterion: "End-to-end paid call on testnet (Base Sepolia, real facilitator)",
      status: "live pending",
      evidence:
        "needs facilitator URL, wallet address and a funded testnet agent wallet (docs/live-cutover.md)",
    },
    {
      criterion: "Licensed facts can't be served",
      status: licensedResp.status === 200 && !leaked ? "passed (synthetic)" : "failed",
      evidence: `planted a licensed claim on ${target}; response ${leaked ? "LEAKED it" : "excluded it"}; x402/human_check asking for licensed is refused by the query layer (tested)`,
    },
    {
      criterion: "Median response time and margin per call reported",
      status: cached.n > 0 && premium.n > 0 ? "passed (synthetic)" : "failed",
      evidence: `cached: ${cached.n} calls, median ${cached.median_ms} ms, price £${cached.price_gbp.toFixed(4)}, margin £${cached.margin_gbp.toFixed(4)}/call; premium (live re-check): ${premium.n} calls, median ${premium.median_ms} ms, margin £${premium.margin_gbp.toFixed(4)}/call (local SQLite + fake Companies House; real latency will be higher)`,
    },
    {
      criterion: "Blind verifier and adaptive re-verification",
      status: blind.checked > 0 ? "passed (synthetic)" : "failed",
      evidence: `${blind.companies} companies, ${blind.checked} facts re-derived blind, ${blind.disagreements} disagreements`,
    },
    {
      criterion: "Companies House Streaming API consumer",
      status: streamed.requested > 0 ? "passed (synthetic)" : "failed",
      evidence: `${streamed.seen} events → ${streamed.requested} re-verification requests; resumes from timepoint ${streamed.timepoint}`,
    },
    {
      criterion: "Request log feeds the x402_discovery module",
      status: disc.candidates > 0 ? "passed (synthetic)" : "failed",
      evidence: `${disc.candidates} companies scored, ${disc.opportunities.length} opportunities`,
    },
  ];
  return { criteria, cached, premium, blind, streamed };
}
