import { loadVerificationConfig } from "@ae/config";
import { describe, expect, it } from "vitest";
import {
  domainOf,
  nameSimilarity,
  normaliseName,
  normalisePostcode,
  resolveEntity,
  scoreCandidate,
} from "../resolve.ts";
import { checkClaims, contextFromClaims } from "../sanity.ts";
import { chClaim, setup } from "./helpers.ts";

const cfg = loadVerificationConfig();

describe("sanity rules", () => {
  const run = "0b6f7f0e-6b1a-4c55-9a8e-2f5d8f1b9a01";
  const check = async (claim: Parameters<typeof chClaim>[1], ctx = {}) =>
    checkClaims([await chClaim(run, claim)], ctx, cfg.sanity).map((f) => f.rule);

  it("incorporation date in the future", async () => {
    expect(
      await check({
        field: "incorporation_date",
        value: "2027-01-01",
        published: "2026-11-01T00:00:00Z",
      }),
    ).toEqual(["incorporation_date_in_future"]);
    expect(
      await check({
        field: "incorporation_date",
        value: "2015-01-01",
        published: "2015-01-01T00:00:00Z",
      }),
    ).toEqual([]);
  });

  it("negative numbers and implausible headcounts", async () => {
    expect(
      await check({ field: "employees_average", value: -3, published: "2026-01-01T00:00:00Z" }),
    ).toEqual(["negative_value"]);
    expect(
      await check({
        field: "employees_average",
        value: 9_000_000,
        published: "2026-01-01T00:00:00Z",
      }),
    ).toEqual(["employees_implausible"]);
    expect(
      await check({ field: "employees_average", value: 12.5, published: "2026-01-01T00:00:00Z" }),
    ).toEqual(["employees_implausible"]);
  });

  it("revenue per employee outside the plausible band", async () => {
    expect(
      await check(
        { field: "employees_average", value: 50, published: "2026-01-01T00:00:00Z" },
        { turnover_gbp: 10_000 },
      ),
    ).toEqual(["revenue_per_employee_out_of_band"]);
    expect(
      await check(
        { field: "employees_average", value: 50, published: "2026-01-01T00:00:00Z" },
        { turnover_gbp: 3_000_000 },
      ),
    ).toEqual([]);
  });

  it("dissolved company with new filings (restoration paperwork allowed)", async () => {
    const ctx = { company_status: "dissolved", dissolution_date: "2025-06-01" };
    const late = { field: "filing_events", published: "2026-01-01T00:00:00Z" };
    expect(await check({ ...late, value: [{ date: "2025-09-01", type: "AA" }] }, ctx)).toEqual([
      "dissolved_with_new_filings",
    ]);
    expect(await check({ ...late, value: [{ date: "2025-09-01", type: "RT01" }] }, ctx)).toEqual(
      [],
    );
    expect(await check({ ...late, value: [{ date: "2025-05-01", type: "AA" }] }, ctx)).toEqual([]);
  });

  it("officer appointed before their birth year", async () => {
    const v = (year: number) => [
      { name: "SMITH, Jo", appointed_on: "2010-05-01", date_of_birth: { month: 3, year } },
    ];
    expect(
      await check({ field: "officers_active", value: v(2012), published: "2026-01-01T00:00:00Z" }),
    ).toEqual(["officer_appointed_before_birth"]);
    expect(
      await check({ field: "officers_active", value: v(1980), published: "2026-01-01T00:00:00Z" }),
    ).toEqual([]);
  });

  it("builds entity context from the batch, latest claim wins", async () => {
    const a = await chClaim(run, {
      field: "company_status",
      value: "active",
      published: "2024-01-01T00:00:00Z",
    });
    const b = await chClaim(run, {
      field: "company_status",
      value: "dissolved",
      published: "2025-01-01T00:00:00Z",
    });
    expect(contextFromClaims([b, a]).company_status).toBe("dissolved");
  });
});

describe("entity resolution helpers", () => {
  it("normalises names, postcodes and domains", () => {
    expect(normaliseName("The Acme Widgets & Co. Limited")).toBe("ACME WIDGETS AND");
    expect(normaliseName("Acme Widgets Ltd")).toBe("ACME WIDGETS");
    expect(normalisePostcode("m11aa")).toBe("M1 1AA");
    expect(normalisePostcode("bl1  1aa")).toBe("BL1 1AA");
    expect(normalisePostcode("not a postcode")).toBeNull();
    expect(domainOf("https://www.acme.co.uk/about?x=1")).toBe("acme.co.uk");
    expect(domainOf("jo@acme.co.uk")).toBe("acme.co.uk");
  });

  it("scores name similarity", () => {
    expect(nameSimilarity("Acme Widgets Ltd", "ACME WIDGETS LIMITED")).toBe(1);
    expect(nameSimilarity("Acme Widgets", "Acme Widget")).toBeGreaterThan(0.7);
    expect(nameSimilarity("Acme Widgets", "Bolton Bakery")).toBeLessThan(0.2);
  });

  it("renormalises weights over the signals both sides have", () => {
    const entity = {
      entity_id: "01234567",
      name: "ACME WIDGETS LTD",
      name_normalised: "ACME WIDGETS",
      postcode: "M1 1AA",
      lad_code: null,
      company_status: "active",
      accounts_category: null,
      sic_codes: [],
      charges_count: null,
      incorporation_date: null,
    };
    expect(scoreCandidate({ name: "Acme Widgets" }, { entity }, cfg.resolution.weights).score).toBe(
      1,
    );
    const s = scoreCandidate(
      { name: "Acme Widgets", postcode: "M1 9ZZ" },
      { entity },
      cfg.resolution.weights,
    );
    expect(s.score).toBeCloseTo((0.6 * 1 + 0.3 * 0.5) / 0.9, 12);
  });
});

describe("resolveEntity", async () => {
  const { storage, runId } = await setup();
  const row = (id: string, name: string, postcode: string) => ({
    entity_id: id,
    name,
    name_normalised: normaliseName(name),
    postcode,
    lad_code: null,
    company_status: "active",
    accounts_category: null,
    sic_codes: [],
    charges_count: null,
    incorporation_date: null,
  });
  await storage.entities.upsertMany(
    [
      row("01234567", "ACME WIDGETS LTD", "M1 1AA"),
      row("07654321", "BOLTON BAKERY LTD", "BL1 1AA"),
    ],
    runId,
  );

  it("exact company number wins", async () => {
    expect(
      await resolveEntity(
        storage,
        { company_number: "01234567", name: "whatever" },
        cfg.resolution,
      ),
    ).toMatchObject({
      outcome: "matched",
      entity_id: "01234567",
      method: "company_number",
    });
  });

  it("high score auto-matches", async () => {
    expect(
      await resolveEntity(
        storage,
        { name: "Acme Widgets Limited", postcode: "m1 1aa" },
        cfg.resolution,
      ),
    ).toMatchObject({
      outcome: "matched",
      entity_id: "01234567",
      method: "score",
    });
  });

  it("middle band goes to adjudication (quarantined until Phase 2's adjudicator)", async () => {
    const r = await resolveEntity(
      storage,
      { name: "Acme Widgets Lt", postcode: "M1 9ZZ" },
      cfg.resolution,
    );
    expect(["adjudicate", "quarantine"]).toContain(r.outcome);
    expect(r.outcome).not.toBe("matched");
  });

  it("adjudicator verdicts are honoured only for real candidates", async () => {
    const adjudicator = {
      adjudicate: async () => ({ entity_id: "99999999", reasoning: "made up" }),
    };
    const r = await resolveEntity(
      storage,
      { name: "Acme Widget", postcode: "BL1 1AA" },
      cfg.resolution,
      adjudicator,
    );
    expect(r.outcome).toBe("quarantine");
  });

  it("no candidates → quarantine", async () => {
    expect(
      (await resolveEntity(storage, { name: "Nobody Here", postcode: "SK1 1AA" }, cfg.resolution))
        .outcome,
    ).toBe("quarantine");
  });
});
