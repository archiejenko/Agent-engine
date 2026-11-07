import { describe, expect, it } from "vitest";
import { ModuleConfig, Opportunity, Outcome, SignalDefinition } from "../index.ts";

const moduleConfig = {
  module: "lead_gen_sme_web",
  version: 3,
  universe: { region: "Greater Manchester", headcount: [5, 100], status: "active" },
  lanes: ["open"],
  confidence_floor: 0.7,
  signals: {
    website_age_years: { weight: 0.3 },
    hiring_momentum: { weight: 0.25 },
    filing_health: { weight: 0.15, invert: true },
    director_change_90d: { weight: 0.3 },
  },
  threshold: 0.6,
  outcome: { event: "positive_reply", window_days: 30, value_field: "deal_value_gbp" },
  explore_share: 0.1,
};

describe("ModuleConfig", () => {
  it("accepts the example from the brief", () => {
    const m = ModuleConfig.parse(moduleConfig);
    expect(m.signals.website_age_years?.invert).toBe(false);
    expect(m.signals.filing_health?.invert).toBe(true);
  });
  it("refuses weights that don't sum to 1", () => {
    const bad = {
      ...moduleConfig,
      signals: { ...moduleConfig.signals, hiring_momentum: { weight: 0.5 } },
    };
    expect(ModuleConfig.safeParse(bad).success).toBe(false);
  });
  it("refuses an empty signal set", () => {
    expect(ModuleConfig.safeParse({ ...moduleConfig, signals: {} }).success).toBe(false);
  });
  it("caps explore_share", () => {
    expect(ModuleConfig.safeParse({ ...moduleConfig, explore_share: 0.9 }).success).toBe(false);
  });
});

describe("SignalDefinition", () => {
  it("accepts a definition", () => {
    expect(
      SignalDefinition.safeParse({
        signal_id: "director_change_90d",
        version: 1,
        description: "Any director appointed or resigned in the last 90 days",
        inputs: ["officer_appointments"],
        min_input_confidence: 0.7,
        function: "signals/director_change_90d.ts",
      }).success,
    ).toBe(true);
  });
});

describe("Opportunity", () => {
  const opp = {
    opportunity_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
    module: "lead_gen_sme_web",
    module_version: 3,
    note_hash: "a".repeat(64),
    entity_id: "01234567",
    as_of: "2026-11-07",
    score: 0.42,
    expected_value_gbp: 120,
    confidence: 0.8,
    trace: [
      {
        signal_id: "a_sig",
        signal_version: 1,
        raw_value: 2,
        normalised: 1,
        weight: 0.3,
        contribution: 0.3,
        fact_ids: ["f1"],
      },
      {
        signal_id: "b_sig",
        signal_version: 1,
        raw_value: 0.4,
        normalised: 0.4,
        weight: 0.3,
        contribution: 0.12,
        fact_ids: ["f2"],
      },
    ],
    lane: "open",
    explore: false,
    status: "proposed",
  };
  it("accepts a fully traced opportunity", () => {
    expect(Opportunity.safeParse(opp).success).toBe(true);
  });
  it("score must equal the sum of contributions (all maths in code, traceable)", () => {
    expect(Opportunity.safeParse({ ...opp, score: 0.9 }).success).toBe(false);
  });
  it("each contribution must equal weight × normalised", () => {
    const bad = {
      ...opp,
      trace: [{ ...opp.trace[0], contribution: 0.2 }, opp.trace[1]],
      score: 0.32,
    };
    expect(Opportunity.safeParse(bad).success).toBe(false);
  });
  it("requires a trace", () => {
    expect(Opportunity.safeParse({ ...opp, trace: [], score: 0 }).success).toBe(false);
  });
});

describe("Outcome", () => {
  it("accepts a boolean or GBP amount", () => {
    const base = {
      opportunity_id: "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed",
      event: "positive_reply",
      observed_at: "2026-11-20T10:00:00Z",
      source: "human",
    };
    expect(Outcome.safeParse({ ...base, value: true }).success).toBe(true);
    expect(Outcome.safeParse({ ...base, value: 1500 }).success).toBe(true);
    expect(Outcome.safeParse({ ...base, value: -5 }).success).toBe(false);
  });
});
