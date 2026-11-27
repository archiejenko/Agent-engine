import { describe, expect, it } from "vitest";
import {
  AuditEntry,
  Business,
  BusinessId,
  Contact,
  IndustriesConfig,
  OpportunityRow,
  SignalRow,
  SourceDefinition,
  ukBusinessId,
  usBusinessId,
} from "../index.ts";

const at = "2026-11-27T12:00:00.000Z";

describe("v4 vault contracts", () => {
  it("business IDs: UK company, US state entity or no-registry; nothing else", () => {
    expect(ukBusinessId("sc123456")).toBe("gb-ch:SC123456");
    expect(usBusinessId("FL", "P12000012345")).toBe("us-fl:P12000012345");
    for (const ok of ["gb-ch:01234567", "us-fl:P12000012345", "bz:01jd2v3k4m5n6p"])
      expect(BusinessId.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["01234567", "gb-ch:123", "us-florida:1", "us-fl:", "bz:x"])
      expect(BusinessId.safeParse(bad).success, bad).toBe(false);
  });

  const business = {
    business_id: "gb-ch:01234567",
    name: "SAMPLE LIMITED",
    name_normalised: "sample",
    market: "UK" as const,
    region: "ENG" as const,
    status: "active",
    company_type: "ltd",
    industry_code: null,
    size_band: null,
    primary_domain: null,
    merged_into: null,
    source_run_id: null,
  };

  it("a business's market follows its ID, and its region belongs to its market", () => {
    expect(Business.safeParse(business).success).toBe(true);
    expect(Business.safeParse({ ...business, market: "US" }).success).toBe(false);
    expect(Business.safeParse({ ...business, region: "FL" }).success).toBe(false);
    expect(
      Business.safeParse({ ...business, business_id: "us-fl:P1", market: "US", region: "FL" })
        .success,
    ).toBe(true);
  });

  it("contacts carry provenance and a lane; region must fit the market", () => {
    const c = {
      contact_id: "c1",
      business_id: "gb-ch:01234567",
      kind: "role_address",
      email: "info@sample.example",
      email_verified: "unknown",
      verifier_source_id: null,
      name: null,
      title: null,
      recipient_type: "corporate",
      source_id: "own_website",
      lane: "open",
      confidence: 0.9,
      market: "UK",
      region: "ENG",
      fetched_at: at,
      synthetic: false,
    };
    expect(Contact.safeParse(c).success).toBe(true);
    expect(Contact.safeParse({ ...c, lane: "paid_own_use" }).success).toBe(true);
    expect(Contact.safeParse({ ...c, region: "TX" }).success).toBe(false);
    const { source_id: _, ...noSource } = c;
    expect(Contact.safeParse(noSource).success).toBe(false);
  });

  it("a scout signal is always untrusted (fetched content)", () => {
    const s = {
      signal_key: "k",
      kind: "scout",
      definition_id: "job_posting",
      definition_version: 0,
      business_id: null,
      problem_id: null,
      value: "x",
      fact_ids: [],
      source_id: null,
      untrusted: false,
      market: "UK",
      region: null,
      observed_at: at,
      valid_from: at,
      lane: "open",
      run_id: null,
      synthetic: false,
    };
    expect(SignalRow.safeParse(s).success).toBe(false);
    expect(SignalRow.safeParse({ ...s, untrusted: true }).success).toBe(true);
    expect(SignalRow.safeParse({ ...s, kind: "engine" }).success).toBe(true);
  });

  it("source definitions: a paid vendor needs a cost model; retention is explicit", () => {
    const src = {
      source_id: "google_places",
      name: "Google Places",
      market: "US",
      region: null,
      kind: "vendor",
      tier: 3,
      lane: "paid_own_use",
      retention: "id_only",
      cost_model: { kind: "per_call", gbp: 0.02, assumed: true },
      freshness_target_h: 720,
      reliability: null,
      terms_url: "https://cloud.google.com/maps-platform/terms",
      terms_checked_at: null,
      connected_by_default: false,
    };
    expect(SourceDefinition.safeParse(src).success).toBe(true);
    expect(SourceDefinition.safeParse({ ...src, cost_model: { kind: "free" } }).success).toBe(
      false,
    );
    const { retention: _, ...noRetention } = src;
    expect(SourceDefinition.safeParse(noRetention).success).toBe(false);
  });

  it("audit entries hash the recipient and name the actor", () => {
    const e = {
      audit_id: "a1",
      at,
      actor: "node:send@1",
      action: "send_email",
      opportunity_id: "opp_x",
      touch_id: "t1",
      recipient_hash: "a".repeat(64),
      basis: "corporate_b2b",
      source_ids: ["companies_house_api"],
      fact_ids: [],
      compliance_pack: "uk@1",
      guardrail_hash: "abc",
      effect_key: "e1",
      market: "UK",
      dry_run: true,
      synthetic: false,
    };
    expect(AuditEntry.safeParse(e).success).toBe(true);
    expect(AuditEntry.safeParse({ ...e, recipient_hash: "info@x.example" }).success).toBe(false);
    expect(AuditEntry.safeParse({ ...e, actor: "someone" }).success).toBe(false);
  });
});

describe("v4 portfolio contracts", () => {
  const opp = {
    opportunity_id: "opp_uk_gm_website_retainer_email",
    version: 1,
    problem_id: "prb_x",
    segment_id: "seg_x",
    route_id: "service_retainer",
    channel_id: "cold_email",
    market: "UK",
    region: "ENG",
    stage: "sense",
    bucket: "explore",
    config: {},
    config_hash: "0123456789ab",
    compiled_graph: null,
    lane: "open",
    parent_opportunity_id: null,
    hypothesis_id: null,
    status: "proposed",
    approval_id: null,
    spend_gbp: 0,
    revenue_gbp: 0,
    observed_cac_gbp: null,
    observed_cost_to_serve_gbp: null,
    synthetic: false,
  };

  it("an opportunity can't be approved or running without Archie's signed approval", () => {
    expect(OpportunityRow.safeParse(opp).success).toBe(true);
    expect(OpportunityRow.safeParse({ ...opp, status: "running" }).success).toBe(false);
    expect(
      OpportunityRow.safeParse({ ...opp, status: "running", approval_id: "ap_1" }).success,
    ).toBe(true);
  });

  it("only registered routes, channels and stages", () => {
    expect(OpportunityRow.safeParse({ ...opp, channel_id: "ai_voice" }).success).toBe(false);
    expect(OpportunityRow.safeParse({ ...opp, route_id: "consulting" }).success).toBe(false);
    expect(OpportunityRow.safeParse({ ...opp, stage: "launch" }).success).toBe(false);
  });

  it("the industries config refuses a seed category mapped to an unknown industry", () => {
    const cfg = {
      version: 1,
      assumed: true,
      industries: [
        {
          code: "construction",
          name: "Construction",
          sic_divisions: ["41"],
          naics_sectors: ["23"],
        },
      ],
      seed_category_industry: { Trades: "construction" },
    };
    expect(IndustriesConfig.safeParse(cfg).success).toBe(true);
    expect(
      IndustriesConfig.safeParse({ ...cfg, seed_category_industry: { Trades: "mining" } }).success,
    ).toBe(false);
  });
});
