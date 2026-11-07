import { loadCompaniesHouseConfig } from "@ae/config";
import { expect, it } from "vitest";
import { ingestClaims } from "../ingest.ts";
import { requestVerification } from "../query.ts";
import { nightlyReverify, planReverification } from "../reverify.ts";
import { CompaniesHouseClient } from "../sources/companies-house/client.ts";
import { fakeChFetch } from "./fixtures/ch.ts";
import { chClaim, setup } from "./helpers.ts";

it("prioritises requested, then stale+uncertain facts, within the call budget", async () => {
  const { storage, ctx, runId } = await setup();
  const old = "2026-09-01T00:00:00Z";
  await ingestClaims(storage, ctx, { run_id: runId, fetched_at: old }, [
    await chClaim(runId, {
      entity: "01111111",
      field: "company_status",
      value: "active",
      published: old,
      fetched: old,
    }),
  ]);
  const fresh = "2026-11-06T00:00:00Z";
  await ingestClaims(storage, ctx, { run_id: runId, fetched_at: fresh }, [
    await chClaim(runId, {
      entity: "02222222",
      field: "company_status",
      value: "active",
      published: fresh,
      fetched: fresh,
    }),
  ]);
  await requestVerification(storage, {
    entities: ["03333333"],
    fields: ["officers_active"],
    reason: "about to email",
  });
  const now = Date.parse("2026-11-07T00:00:00Z");
  const plan = await planReverification(storage, ctx, now);
  expect(plan.map((p) => p.entity_id)).toEqual(["03333333", "01111111", "02222222"]);
  const client = new CompaniesHouseClient({
    apiKey: "k",
    config: loadCompaniesHouseConfig(),
    fetch: fakeChFetch(),
    sleep: async () => {},
  });
  const r = await nightlyReverify(storage, ctx, client, loadCompaniesHouseConfig(), {
    now,
    budgetCalls: 9,
  });
  expect(r.processed).toBe(2); // 9 calls ÷ 4.2 per company
  expect(await storage.verificationRequests.listOpen(5)).toEqual([]); // request served
});
