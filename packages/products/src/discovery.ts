import type { Claim } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import {
  canonicalJson,
  ingestClaims,
  stableUuid,
  type VerificationContext,
} from "@ae/verification";

/**
 * Feeds the x402_discovery module: how many distinct paying agents checked each company in the last
 * 30 days becomes a fact (source "x402_requests", our own log), so signals read it like any other fact.
 */
export async function recordX402Interest(
  storage: Storage,
  ctx: VerificationContext,
  now = new Date(),
) {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const rows = await storage.x402.interest(since);
  const run = await storage.runs.start({ kind: "x402_interest" });
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const claims: Claim[] = [];
  for (const r of rows) {
    claims.push({
      claim_id: await stableUuid([
        "x402_requests",
        r.company_number,
        "x402_checks_30d",
        day,
        canonicalJson(r.payers),
      ]),
      entity_id: r.company_number,
      raw_entity_ref: { source_id: r.company_number, name: null },
      field: "x402_checks_30d",
      value: r.payers,
      source: "x402_requests",
      source_tier: 2,
      lane: "open",
      method: "api",
      evidence: { kind: "record", ref: `x402_requests since ${since}` },
      observed_at: at,
      published_at: at,
      fetched_at: at,
      run_id: run.run_id,
    });
  }
  if (claims.length)
    await ingestClaims(storage, ctx, { run_id: run.run_id, fetched_at: at }, claims);
  await storage.runs.finish(run.run_id, "succeeded");
  return { companies: claims.length };
}
