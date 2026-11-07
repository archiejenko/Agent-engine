import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim, VerifiedFact } from "@ae/contracts";
import { FakeModel } from "@ae/ports";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { defaultContext, ingestClaims, stableUuid } from "@ae/verification";
import { describe, expect, it } from "vitest";
import {
  checkRationale,
  explainOpportunity,
  fakeExplainer,
  templateRationale,
} from "../explain.ts";
import type { FactMap } from "../facts.ts";
import { InvalidFrameworkError, parseFramework } from "../framework.ts";
import { reviewQueue } from "../queue.ts";
import { runModule, scoreEntity, winProbability } from "../runner.ts";
import { SIGNALS } from "../signals.ts";

const NOTE = readFileSync(
  join(import.meta.dirname, "../../../../brain/frameworks/lead_gen_sme_web.md"),
  "utf8",
);
const AS_OF = Date.parse("2026-11-08T23:59:59Z");
const fact = (
  field: string,
  value: VerifiedFact["value"],
  o: Partial<VerifiedFact> = {},
): VerifiedFact => ({
  entity_id: "01234567",
  field,
  value,
  confidence: 0.95,
  supporting_claims: ["6f1c2a4e-1d2b-4e3f-8a9b-0c1d2e3f4a5b"],
  conflicting_claims: [],
  lane: "open",
  valid_from: "2026-01-01T00:00:00.000Z",
  first_observed_at: "2026-01-01T00:00:00.000Z",
  last_verified_at: "2026-11-08T00:00:00.000Z",
  expires_at: null,
  status: "verified",
  ...o,
});
const facts = (...fs: VerifiedFact[]): FactMap => new Map(fs.map((f) => [f.field, f]));

describe("signal library", () => {
  it("director_change_90d", () => {
    const s = SIGNALS.director_change_90d;
    expect(
      s?.compute(facts(fact("officer_appointments", [{ appointed_on: "2026-09-01" }])), AS_OF)
        .value,
    ).toBe(1);
    expect(
      s?.compute(
        facts(fact("officer_appointments", [{ appointed_on: "2025-01-01", resigned_on: null }])),
        AS_OF,
      ).value,
    ).toBe(0);
    expect(s?.compute(facts(), AS_OF).value).toBeNull();
  });
  it("website_age_years: no website is oldest; else latest of copyright and last-modified", () => {
    const s = SIGNALS.website_age_years;
    expect(s?.compute(facts(fact("website_found", false)), AS_OF).value).toBe(10);
    expect(
      s?.compute(
        facts(
          fact("website_found", true),
          fact("website_copyright_year", 2016),
          fact("website_last_modified", "2019-04-01"),
        ),
        AS_OF,
      ).value,
    ).toBe(7);
    expect(s?.normalise(7)).toBeCloseTo(0.7, 12);
  });
  it("filing_health penalises overdue accounts and no recent accounts", () => {
    const s = SIGNALS.filing_health;
    expect(
      s?.compute(
        facts(
          fact("accounts_overdue", false),
          fact("filing_events", [{ category: "accounts", date: "2026-03-01" }]),
        ),
        AS_OF,
      ).value,
    ).toBe(1);
    expect(
      s?.compute(
        facts(
          fact("accounts_overdue", true),
          fact("filing_events", [{ category: "accounts", date: "2023-03-01" }]),
        ),
        AS_OF,
      ).value,
    ).toBeCloseTo(0.3, 12);
  });
  it("size_band uses staff numbers, falls back to accounts category, unknown is null", () => {
    const s = SIGNALS.size_band;
    expect(s?.compute(facts(fact("employees_average", 30)), AS_OF).value).toBe(0.75);
    expect(s?.compute(facts(fact("accounts_category", "micro-entity")), AS_OF).value).toBe(0.25);
    expect(s?.compute(facts(), AS_OF).value).toBeNull();
  });
  it("hiring, ownership change, officers, charges, age", () => {
    expect(
      SIGNALS.hiring_momentum?.compute(facts(fact("job_postings", ["A", "B"])), AS_OF).value,
    ).toBe(2);
    expect(
      SIGNALS.ownership_change_180d?.compute(
        facts(fact("psc_history", [{ notified_on: "2026-08-01" }])),
        AS_OF,
      ).value,
    ).toBe(1);
    expect(
      SIGNALS.officer_count?.compute(facts(fact("officers_active", [{}, {}, {}])), AS_OF).value,
    ).toBe(3);
    expect(
      SIGNALS.new_charge_180d?.compute(
        facts(fact("charges", [{ created_on: "2026-07-01" }])),
        AS_OF,
      ).value,
    ).toBe(1);
    expect(
      SIGNALS.company_age_years?.compute(facts(fact("incorporation_date", "2016-11-08")), AS_OF)
        .value,
    ).toBeCloseTo(10, 1);
  });
});

describe("framework notes", () => {
  it("parses the lead gen note and hashes it", async () => {
    const fw = await parseFramework(NOTE);
    expect(fw.config.module).toBe("lead_gen_sme_web");
    expect(fw.config.signals.filing_health?.invert).toBe(true);
    expect(fw.note_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await parseFramework(`${NOTE}\nedit`)).note_hash).not.toBe(fw.note_hash);
  });
  it("refuses invalid notes", async () => {
    await expect(parseFramework("no front matter")).rejects.toThrow(InvalidFrameworkError);
    await expect(
      parseFramework(NOTE.replace("weight: 0.30 }\n  hiring", "weight: 0.90 }\n  hiring")),
    ).rejects.toThrow(/sum to 1/);
    await expect(parseFramework(NOTE.replace("hiring_momentum", "made_up_signal"))).rejects.toThrow(
      /unknown signals/,
    );
  });
});

describe("scoring (all maths in code)", async () => {
  const fw = await parseFramework(NOTE);
  it("score = Σ weight × normalised; invert flips; unknown is neutral 0.5", () => {
    const d = scoreEntity(
      facts(
        fact("website_found", false),
        fact("accounts_overdue", true),
        fact("filing_events", []),
        fact("officer_appointments", [{ appointed_on: "2026-10-01" }]),
      ),
      fw,
      AS_OF,
    );
    // website 1.0×0.30 + hiring (unknown) 0.5×0.25 + filing_health raw 0.3 → inverted 0.7 ×0.15 + director 1×0.30
    expect(d.score).toBeCloseTo(0.3 + 0.125 + 0.105 + 0.3, 12);
    const hiring = d.trace.find((t) => t.signal_id === "hiring_momentum");
    expect(hiring).toMatchObject({ raw_value: null, normalised: 0.5 });
    expect(d.confidence).toBe(0.95);
  });
  it("opportunity confidence is the lowest among driving facts", () => {
    const d = scoreEntity(
      facts(fact("website_found", false, { confidence: 0.6 }), fact("officer_appointments", [])),
      fw,
      AS_OF,
    );
    expect(d.confidence).toBe(0.6);
  });
  it("win probability scales with score and is capped", () => {
    expect(winProbability(0.5, 0.02)).toBeCloseTo(0.02, 12);
    expect(winProbability(1, 0.9)).toBe(1);
  });
});

describe("module runner end to end", async () => {
  const storage = await openSqliteStorage(":memory:");
  const ctx = defaultContext();
  const run = (await storage.runs.start({ kind: "seed" })).run_id;
  const ids = Array.from({ length: 40 }, (_, i) => String(30_000_000 + i));
  await storage.entities.upsertMany(
    ids.map((id) => ({
      entity_id: id,
      name: `CO ${id}`,
      name_normalised: `CO ${id}`,
      postcode: "M1 1AA",
      lad_code: "E08000003",
      company_status: "active",
      accounts_category: null,
      sic_codes: [],
      charges_count: 0,
      incorporation_date: null,
    })),
    run,
  );
  await storage.universe.setMany(
    ids.map((id) => ({
      universe: "lead_gen_sme_web_v1",
      entity_id: id,
      included: true,
      reason: "in_universe",
      staff_flag: "known",
    })),
    run,
  );
  const claim = async (
    id: string,
    field: string,
    value: Claim["value"],
    source = "companies_house",
    tier = 1,
  ): Promise<Claim> => ({
    claim_id: await stableUuid([source, id, field, JSON.stringify(value)]),
    entity_id: id,
    raw_entity_ref: { source_id: id, name: null },
    field,
    value,
    source,
    source_tier: tier,
    lane: "open",
    method: "api",
    evidence: { kind: "record", ref: "test" },
    observed_at: "2026-11-01T00:00:00Z",
    published_at: "2026-11-01T00:00:00Z",
    fetched_at: "2026-11-01T00:00:00Z",
    run_id: run,
  });
  const claims: Claim[] = [];
  for (const [i, id] of ids.entries()) {
    claims.push(
      await claim(
        id,
        "officer_appointments",
        i % 2 === 0
          ? [{ appointed_on: "2026-10-01", resigned_on: null }]
          : [{ appointed_on: "2015-01-01", resigned_on: null }],
      ),
    );
    claims.push(await claim(id, "website_found", i % 3 !== 0, "website_discovery", 3));
    claims.push(await claim(id, "accounts_overdue", i % 5 === 0));
  }
  await ingestClaims(storage, ctx, { run_id: run, fetched_at: "2026-11-01T00:00:00Z" }, claims);
  const fw = await parseFramework(NOTE);

  it("ranks, traces, explores and stores opportunities", async () => {
    const r = await runModule(storage, ctx, fw, { asOf: "2026-11-01" });
    expect(r.candidates).toBe(40);
    const main = r.opportunities.filter((o) => !o.explore);
    expect(main.every((o) => o.score >= fw.config.threshold)).toBe(true);
    expect(main.map((o) => o.score)).toEqual([...main.map((o) => o.score)].sort((a, b) => b - a));
    const explore = r.opportunities.filter((o) => o.explore);
    expect(explore.length).toBe(Math.min(Math.round(0.1 * main.length), explore.length));
    for (const o of explore) expect(o.score).toBeLessThan(fw.config.threshold);
    const stored = await storage.opportunities.list({ runId: r.run_id, limit: 100 });
    expect(stored).toHaveLength(r.opportunities.length);
    expect(stored[0]?.note_hash).toBe(fw.note_hash);
    // Every trace item's fact ids exist as facts for that company at asOf.
    for (const o of stored)
      for (const t of o.trace)
        for (const fid of t.fact_ids) expect(fid.startsWith(`${o.entity_id}/`)).toBe(true);
  });

  it("is reproducible: same inputs + same note → same ranking and scores", async () => {
    const a = await runModule(storage, ctx, fw, { asOf: "2026-11-01", persist: false });
    const b = await runModule(storage, ctx, fw, { asOf: "2026-11-01", persist: false });
    expect(a.opportunities.map((o) => [o.entity_id, o.score, o.explore])).toEqual(
      b.opportunities.map((o) => [o.entity_id, o.score, o.explore]),
    );
  });

  it("explanations cite only trace facts; a model that invents falls back to the template", async () => {
    const [o] = (await storage.opportunities.list({ status: "proposed", limit: 1 })) as [
      Awaited<ReturnType<typeof storage.opportunities.list>>[0],
    ];
    const good = await explainOpportunity(new FakeModel({ opportunity_explain: fakeExplainer }), o);
    expect(good.problems).toEqual([]);
    expect(good.used_model).toBe(true);
    expect(checkRationale(good.rationale, o)).toEqual([]);
    const liar = await explainOpportunity(
      new FakeModel({ opportunity_explain: () => "They have 250 staff [made/up/fact]." }),
      o,
    );
    expect(liar.used_model).toBe(false);
    expect(liar.problems).toEqual(["cites unknown fact made/up/fact", "number 250 not in trace"]);
    expect(liar.rationale).toBe(templateRationale(o));
  });

  it("the review queue shows each company once with all its reasons", async () => {
    await runModule(
      storage,
      ctx,
      { ...fw, config: { ...fw.config, module: "second_module" } },
      { asOf: "2026-11-01" },
    );
    const q = await reviewQueue(storage, 500);
    expect(new Set(q.map((x) => x.entity_id)).size).toBe(q.length);
    expect(q.some((x) => new Set(x.opportunities.map((o) => o.module)).size === 2)).toBe(true);
  });
});
