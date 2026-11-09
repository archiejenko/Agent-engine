import { LaneRefusedError, toMillis } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFactAt } from "../build.ts";
import type { VerificationContext } from "../context.ts";
import { ingestClaims } from "../ingest.ts";
import { getVerifiedFacts, requestVerification } from "../query.ts";
import { rollbackRun } from "../rollback.ts";
import { chClaim, setup } from "./helpers.ts";

let storage: Storage;
let ctx: VerificationContext;
let runId: string;
const FETCH = "2026-11-07T09:00:00Z";

beforeEach(async () => {
  ({ storage, ctx, runId } = await setup());
});

const ingest = (claims: Awaited<ReturnType<typeof chClaim>>[], fetched = FETCH, run = runId) =>
  ingestClaims(storage, ctx, { run_id: run, fetched_at: fetched }, claims);

const q = (o: Partial<Parameters<typeof getVerifiedFacts>[2]> & { asOf: string }) =>
  getVerifiedFacts(storage, ctx, {
    entities: ["01234567"],
    fields: ["officers_active"],
    minConfidence: 0,
    lanes: ["open"],
    caller: "internal",
    ...o,
  } as Parameters<typeof getVerifiedFacts>[2]);

describe("GATE: asOf returns what was known on that date", () => {
  beforeEach(async () => {
    await ingest([
      // Director X appointed; filing published 2024-03-01.
      await chClaim(runId, {
        field: "officers_active",
        value: ["X"],
        published: "2024-03-01T00:00:00Z",
      }),
      // Director Y appointed with effect 2025-05-01, but the filing was only published 2025-06-10.
      await chClaim(runId, {
        field: "officers_active",
        value: ["X", "Y"],
        observed: "2025-05-01T00:00:00Z",
        published: "2025-06-10T00:00:00Z",
      }),
    ]);
  });

  it("before anything was published: nothing", async () => {
    expect(await q({ asOf: "2024-01-01" })).toEqual([]);
  });

  it("between the two filings: the earlier state", async () => {
    const [f] = await q({ asOf: "2025-01-01" });
    expect(f?.value).toEqual(["X"]);
    expect(f?.valid_from).toBe("2024-03-01T00:00:00.000Z");
  });

  it("uses the PUBLISHED date, not the effective date (no look-ahead)", async () => {
    const [f] = await q({ asOf: "2025-05-15" }); // change effective but not yet knowable
    expect(f?.value).toEqual(["X"]);
  });

  it("after the second filing: the later state", async () => {
    const [f] = await q({ asOf: "2025-07-01" });
    expect(f?.value).toEqual(["X", "Y"]);
  });

  it("confidence is computed as it stood then (the register was asserting it, so fresh)", async () => {
    const [f] = await q({ asOf: "2025-01-01" });
    expect(f?.confidence).toBeCloseTo(0.95, 12);
  });

  it("strict mode only returns what we had actually fetched by then", async () => {
    expect(await q({ asOf: "2025-07-01", mode: "strict" })).toEqual([]);
    const [f] = await q({ asOf: "2026-11-08", mode: "strict" });
    expect(f?.value).toEqual(["X", "Y"]);
  });

  it("never returns a fact with valid_from after asOf", async () => {
    for (const asOf of ["2024-02-29", "2024-03-01", "2025-06-09", "2025-06-10", "2026-12-01"]) {
      for (const f of await q({ asOf })) {
        expect(toMillis(f.valid_from)).toBeLessThanOrEqual(toMillis(`${asOf}T23:59:59.999Z`));
      }
    }
  });
});

describe("GATE: open-lane callers can't receive licensed facts", () => {
  beforeEach(async () => {
    await ingest([
      await chClaim(runId, {
        entity: "01111111",
        field: "employees_average",
        value: 20,
        published: "2026-01-01T00:00:00Z",
      }),
      await chClaim(runId, {
        entity: "02222222",
        field: "employees_average",
        value: 40,
        published: "2026-01-01T00:00:00Z",
        source: "test_vendor",
        tier: 4,
        lane: "licensed",
      }),
      // Open AND licensed agreeing: the fact inherits licensed.
      await chClaim(runId, {
        entity: "03333333",
        field: "employees_average",
        value: 50,
        published: "2026-01-01T00:00:00Z",
      }),
      await chClaim(runId, {
        entity: "03333333",
        field: "employees_average",
        value: 52,
        published: "2026-01-01T00:00:00Z",
        source: "test_vendor",
        tier: 4,
        lane: "licensed",
      }),
    ]);
  });
  const base = {
    entities: ["01111111", "02222222", "03333333"],
    fields: ["employees_average"],
    minConfidence: 0,
    asOf: "2026-11-07",
  };

  it("x402 asking for open gets only the purely open fact", async () => {
    const facts = await getVerifiedFacts(storage, ctx, {
      ...base,
      lanes: ["open"],
      caller: "x402",
    });
    expect(facts.map((f) => [f.entity_id, f.lane])).toEqual([["01111111", "open"]]);
  });

  it("x402 and human_check asking for licensed are refused outright", async () => {
    await expect(
      getVerifiedFacts(storage, ctx, { ...base, lanes: ["licensed"], caller: "x402" }),
    ).rejects.toThrow(LaneRefusedError);
    await expect(
      getVerifiedFacts(storage, ctx, {
        ...base,
        lanes: ["open", "licensed"],
        caller: "human_check",
      }),
    ).rejects.toThrow(LaneRefusedError);
  });

  it("a fact with any licensed supporting claim is licensed", async () => {
    const facts = await getVerifiedFacts(storage, ctx, {
      ...base,
      lanes: ["open", "licensed"],
      caller: "opportunity",
    });
    expect(Object.fromEntries(facts.map((f) => [f.entity_id, f.lane]))).toEqual({
      "01111111": "open",
      "02222222": "licensed",
      "03333333": "licensed",
    });
  });
});

describe("triangulation, staleness and filters", () => {
  it("clear winner: verified, conflicting claim recorded, confidence penalised", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 12,
        published: "2026-01-01T00:00:00Z",
      }),
      await chClaim(runId, {
        field: "employees_average",
        value: 30,
        published: "2026-02-01T00:00:00Z",
        source: "company_website",
        tier: 3,
      }),
    ]);
    const f = await storage.facts.getCurrent("01234567", "employees_average");
    expect(f?.status).toBe("verified");
    expect(f?.value).toBe(12);
    expect(f?.conflicting_claims).toHaveLength(1);
    expect(f?.confidence).toBeLessThan(0.95);
  });

  it("no clear margin: conflict (goes to the review queue)", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 12,
        published: "2026-01-01T00:00:00Z",
        source: "company_website",
        tier: 3,
      }),
      await chClaim(runId, {
        field: "employees_average",
        value: 30,
        published: "2026-02-01T00:00:00Z",
        source: "test_vendor",
        tier: 3,
      }),
    ]);
    expect((await storage.facts.getCurrent("01234567", "employees_average"))?.status).toBe(
      "conflict",
    );
    const forX402 = await getVerifiedFacts(storage, ctx, {
      entities: ["01234567"],
      fields: ["employees_average"],
      minConfidence: 0,
      asOf: "2026-11-07",
      lanes: ["open"],
      caller: "x402",
    });
    expect(forX402).toEqual([]);
  });

  it("copies of the same register don't conflict: the freshest copy wins", async () => {
    await ingest(
      [
        await chClaim(runId, {
          field: "company_status",
          value: "active",
          published: "2026-10-01T00:00:00Z",
          source: "companies_house_bulk",
          fetched: "2026-10-01T00:00:00Z",
        }),
      ],
      "2026-10-01T00:00:00Z",
    );
    await ingest([
      await chClaim(runId, {
        field: "company_status",
        value: "liquidation",
        published: "2026-11-05T00:00:00Z",
      }),
    ]);
    const f = await storage.facts.getCurrent("01234567", "company_status");
    expect(f?.status).toBe("verified");
    expect(f?.value).toBe("liquidation");
    expect(f?.conflicting_claims).toEqual([]);
  });

  it("agreeing within tolerance supports rather than conflicts (headcount ±10%)", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 50,
        published: "2026-01-01T00:00:00Z",
      }),
      await chClaim(runId, {
        field: "employees_average",
        value: 54,
        published: "2026-02-01T00:00:00Z",
        source: "company_website",
        tier: 3,
      }),
    ]);
    const f = await storage.facts.getCurrent("01234567", "employees_average");
    expect(f?.value).toBe(50);
    expect(f?.supporting_claims).toHaveLength(2);
    expect(f?.confidence).toBeCloseTo(1 - 0.05 * 0.25, 9);
  });

  it("facts past their shelf life are stale and excluded once a confidence floor is set", async () => {
    await ingest([
      await chClaim(runId, {
        field: "company_status",
        value: "active",
        published: "2026-11-01T00:00:00Z",
      }),
    ]);
    const later = {
      entities: ["01234567"],
      fields: ["company_status"],
      asOf: "2026-11-20",
      lanes: ["open" as const],
    };
    expect(
      await getVerifiedFacts(storage, ctx, { ...later, minConfidence: 0.5, caller: "opportunity" }),
    ).toEqual([]);
    const [f] = await getVerifiedFacts(storage, ctx, {
      ...later,
      minConfidence: 0,
      caller: "dashboard",
    });
    expect(f?.status).toBe("stale");
  });

  it("filters select the universe at asOf", async () => {
    await ingest([
      await chClaim(runId, {
        entity: "01111111",
        field: "registered_office_lad",
        value: "E08000003",
        published: "2026-01-01T00:00:00Z",
        source: "ons_postcode_directory",
        tier: 2,
      }),
      await chClaim(runId, {
        entity: "02222222",
        field: "registered_office_lad",
        value: "E06000001",
        published: "2026-01-01T00:00:00Z",
        source: "ons_postcode_directory",
        tier: 2,
      }),
      await chClaim(runId, {
        entity: "01111111",
        field: "company_status",
        value: "active",
        published: "2026-11-07T00:00:00Z",
      }),
      await chClaim(runId, {
        entity: "02222222",
        field: "company_status",
        value: "active",
        published: "2026-11-07T00:00:00Z",
      }),
    ]);
    const facts = await getVerifiedFacts(storage, ctx, {
      entities: {
        filters: [{ field: "registered_office_lad", op: "in", value: ["E08000003", "E08000001"] }],
      },
      fields: ["company_status"],
      minConfidence: 0.5,
      asOf: "2026-11-07",
      lanes: ["open"],
      caller: "opportunity",
    });
    expect(facts.map((f) => f.entity_id)).toEqual(["01111111"]);
  });
});

describe("period-dated facts (headcount from accounts)", () => {
  it("don't decay, but go stale once a newer period is due", async () => {
    await ingest([
      await chClaim(runId, {
        field: "employees_average",
        value: 12,
        observed: "2025-03-31T00:00:00Z", // period end
        published: "2025-11-20T00:00:00Z", // accounts published
        source: "companies_house_accounts",
      }),
    ]);
    const q2 = (asOf: string) =>
      getVerifiedFacts(storage, ctx, {
        entities: ["01234567"],
        fields: ["employees_average"],
        minConfidence: 0,
        asOf,
        lanes: ["open"],
        caller: "dashboard",
      });
    const [a] = await q2("2026-11-07"); // 19 months after period end
    expect(a?.confidence).toBeCloseTo(0.95, 12);
    expect(a?.status).toBe("verified");
    const [b] = await q2("2027-01-15"); // > 640 days after period end
    expect(b?.status).toBe("stale");
    expect(b?.confidence).toBeCloseTo(0.95, 12);
  });
});

describe("site-level website facts (hold until expiry)", () => {
  it("keep their confidence for the 90-day shelf life, then go stale (no extra crawls, same floor)", async () => {
    await ingest([
      await chClaim(runId, {
        field: "website_found",
        value: true,
        published: "2026-09-01T00:00:00Z",
        fetched: "2026-09-01T00:00:00Z",
        source: "website_discovery",
        tier: 3,
      }),
    ]);
    const q2 = (asOf: string) =>
      getVerifiedFacts(storage, ctx, {
        entities: ["01234567"],
        fields: ["website_found"],
        minConfidence: 0,
        asOf,
        lanes: ["open"],
        caller: "dashboard",
      });
    const [day60] = await q2("2026-10-31");
    expect(day60?.confidence).toBeCloseTo(0.75, 12); // still above the 0.7 lead-gen floor
    expect(day60?.status).toBe("verified");
    const [day95] = await q2("2026-12-05");
    expect(day95?.status).toBe("stale");
  });
});

describe("ingest pipeline", () => {
  it("drops and logs unknown fields; never guesses", async () => {
    const stats = await ingest([
      await chClaim(runId, {
        field: "favourite_colour",
        value: "blue",
        published: "2026-01-01T00:00:00Z",
      }),
    ]);
    expect(stats.dropped_unknown_field).toBe(1);
    expect(await storage.dropped.list(runId)).toEqual([
      {
        source: "companies_house",
        source_field: "favourite_colour",
        run_id: runId,
        occurrences: 1,
      },
    ]);
    expect(await storage.facts.countCurrent()).toBe(0);
  });

  it("claims failing a sanity rule are stored with the rule and never become facts", async () => {
    const bad = await chClaim(runId, {
      field: "incorporation_date",
      value: "2030-01-01",
      published: "2026-01-01T00:00:00Z",
    });
    const stats = await ingest([bad]);
    expect(stats.rejected).toBe(1);
    expect(await storage.claims.get(bad.claim_id)).toEqual(bad);
    expect((await storage.claims.listRejections(5))[0]?.rule).toBe("incorporation_date_in_future");
    expect(await storage.facts.getCurrent("01234567", "incorporation_date")).toBeNull();
  });

  it("re-ingesting the same data is idempotent: observation recorded, no new claim or version", async () => {
    const c = await chClaim(runId, {
      field: "company_status",
      value: "active",
      published: "2026-11-01T00:00:00Z",
    });
    await ingest([c]);
    const run2 = (await storage.runs.start({ kind: "refresh" })).run_id;
    const stats = await ingest([c], "2026-11-14T09:00:00Z", run2);
    expect(stats.inserted).toBe(0);
    expect(stats.facts_touched).toBe(1);
    expect(stats.facts_versions_written).toBe(0);
    expect((await storage.facts.getCurrent("01234567", "company_status"))?.last_verified_at).toBe(
      "2026-11-14T09:00:00.000Z",
    );
    expect(await storage.facts.listVersions("01234567", "company_status")).toHaveLength(1);
  });

  it("every fact traces to its claims, run and evidence", async () => {
    const c = await chClaim(runId, {
      field: "sic_codes",
      value: ["62012"],
      published: "2026-01-01T00:00:00Z",
    });
    await ingest([c]);
    const f = await storage.facts.getCurrent("01234567", "sic_codes");
    const [claimId] = f?.supporting_claims ?? [];
    const claim = await storage.claims.get(claimId as string);
    expect(claim?.run_id).toBe(runId);
    expect(claim?.evidence).toEqual({ kind: "record", ref: "test:01234567:sic_codes" });
    const [v] = await storage.facts.listVersions("01234567", "sic_codes");
    expect(v?.run_id).toBe(runId);
  });

  it("requestVerification queues work", async () => {
    await requestVerification(storage, {
      entities: ["01234567"],
      fields: ["officers_active", "company_status"],
      reason: "about to email",
    });
    expect((await storage.verificationRequests.listOpen(10)).map((r) => r.field).sort()).toEqual([
      "company_status",
      "officers_active",
    ]);
  });
});

describe("rollback by run_id (reproducibility)", () => {
  it("restores the previous facts and keeps everything", async () => {
    await ingest([
      await chClaim(runId, {
        field: "company_status",
        value: "active",
        published: "2026-01-01T00:00:00Z",
      }),
    ]);
    const bad = (await storage.runs.start({ kind: "bad" })).run_id;
    await ingest(
      [
        await chClaim(bad, {
          field: "company_status",
          value: "liquidation",
          published: "2026-11-01T00:00:00Z",
        }),
      ],
      FETCH,
      bad,
    );
    expect((await storage.facts.getCurrent("01234567", "company_status"))?.value).toBe(
      "liquidation",
    );

    const r = await rollbackRun(storage, ctx, bad);
    expect(r.facts_affected).toBe(1);
    expect((await storage.facts.getCurrent("01234567", "company_status"))?.value).toBe("active");
    expect((await storage.runs.get(bad))?.status).toBe("rolled_back");
    // History kept: active, liquidation, active again.
    expect(
      (await storage.facts.listVersions("01234567", "company_status")).map((v) => v.fact.value),
    ).toEqual(["active", "liquidation", "active"]);
    await expect(rollbackRun(storage, ctx, bad)).rejects.toThrow(/already/);
  });

  it("same inputs and config produce the same fact", async () => {
    const claims = [
      await chClaim(runId, {
        field: "employees_average",
        value: 50,
        published: "2026-01-01T00:00:00Z",
      }),
      await chClaim(runId, {
        field: "employees_average",
        value: 54,
        published: "2026-02-01T00:00:00Z",
        source: "company_website",
        tier: 3,
      }),
    ];
    const usable = claims.map((claim) => ({ claim, observations: [FETCH] }));
    const at = Date.parse("2026-11-07T00:00:00Z");
    const a = buildFactAt("01234567", "employees_average", usable, ctx, at, "reconstructed");
    const b = buildFactAt(
      "01234567",
      "employees_average",
      [...usable].reverse(),
      ctx,
      at,
      "reconstructed",
    );
    expect(a).toEqual(b);
  });
});
