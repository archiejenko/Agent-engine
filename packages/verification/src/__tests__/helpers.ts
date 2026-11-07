import type { Claim } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { defaultContext, type VerificationContext } from "../context.ts";
import { stableUuid } from "../ids.ts";

export async function setup(): Promise<{
  storage: Storage;
  ctx: VerificationContext;
  runId: string;
}> {
  const storage = await openSqliteStorage(":memory:");
  const ctx = defaultContext();
  // A test-only licensed source, so lane rules can be exercised (no licensed source exists in config).
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
      company_website: {
        tier: 3,
        upstream: "company_website",
        continuous: false,
        lane: "open",
        description: "test",
      },
    },
  };
  const runId = (await storage.runs.start({ kind: "test" })).run_id;
  return { storage, ctx, runId };
}

export async function chClaim(
  runId: string,
  o: {
    entity?: string;
    field: string;
    value: Claim["value"];
    published: string;
    observed?: string;
    fetched?: string;
    source?: string;
    tier?: number;
    lane?: "open" | "licensed";
  },
): Promise<Claim> {
  const entity = o.entity ?? "01234567";
  const source = o.source ?? "companies_house";
  return {
    claim_id: await stableUuid([source, entity, o.field, o.published, JSON.stringify(o.value)]),
    entity_id: entity,
    raw_entity_ref: { source_id: entity, name: "ACME WIDGETS LTD" },
    field: o.field,
    value: o.value,
    source,
    source_tier: o.tier ?? 1,
    lane: o.lane ?? "open",
    method: "api",
    evidence: { kind: "record", ref: `test:${entity}:${o.field}` },
    observed_at: o.observed ?? o.published,
    published_at: o.published,
    fetched_at: o.fetched ?? "2026-11-07T09:00:00Z",
    run_id: runId,
  };
}
