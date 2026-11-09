import { describe, expect, it } from "vitest";
import {
  Claim,
  CompanyNumber,
  combineLanes,
  FieldDefinition,
  FieldRegistry,
  LaneRefusedError,
  parseGetVerifiedFactsParams,
  RequestVerificationParams,
  VerifiedFact,
  valueAppearsInEvidence,
} from "../index.ts";
import { CLAIM_A, CLAIM_B, claim, fact } from "./fixtures.ts";

describe("CompanyNumber", () => {
  it.each(["01234567", "SC123456", "NI012345", "OC301234", "R0000123"])("accepts %s", (n) => {
    expect(CompanyNumber.safeParse(n).success).toBe(true);
  });
  it.each(["1234567", "sc123456", "ABC12345", "", "012345678"])("rejects %s", (n) => {
    expect(CompanyNumber.safeParse(n).success).toBe(false);
  });
});

describe("Claim", () => {
  it("accepts a valid Companies House claim", () => {
    expect(Claim.parse(claim())).toBeTruthy();
  });

  it("allows entity_id to be null until matched", () => {
    expect(Claim.safeParse(claim({ entity_id: null })).success).toBe(true);
  });

  it("requires published_at (point-in-time uses it)", () => {
    const { published_at: _, ...rest } = claim();
    expect(Claim.safeParse(rest).success).toBe(false);
  });

  it("rejects published_at after fetched_at", () => {
    const r = Claim.safeParse(claim({ published_at: "2026-12-01T00:00:00Z" }));
    expect(r.success).toBe(false);
  });

  it("rejects source tiers outside 1-5 and unknown methods/lanes", () => {
    expect(Claim.safeParse(claim({ source_tier: 0 })).success).toBe(false);
    expect(Claim.safeParse(claim({ source_tier: 6 })).success).toBe(false);
    expect(Claim.safeParse({ ...claim(), method: "guess" }).success).toBe(false);
    expect(Claim.safeParse({ ...claim(), lane: "secret" }).success).toBe(false);
  });

  it("rejects non-snake_case field names", () => {
    expect(Claim.safeParse(claim({ field: "Company Status" })).success).toBe(false);
  });

  describe("llm_extract (guardrail 3)", () => {
    const base = { method: "llm_extract" as const, source_tier: 5, source: "company_website" };

    it("requires evidence", () => {
      expect(Claim.safeParse(claim({ ...base, evidence: null })).success).toBe(false);
    });

    it("requires a span, not just a record ref", () => {
      const r = Claim.safeParse(claim({ ...base, evidence: { kind: "record", ref: "x" } }));
      expect(r.success).toBe(false);
    });

    it("accepts a value that appears in its span", () => {
      const r = Claim.safeParse(
        claim({
          ...base,
          field: "employees_estimate",
          value: 1200,
          evidence: {
            kind: "span",
            ref: "https://acme.example/about",
            text: "We employ 1,200 people",
          },
        }),
      );
      expect(r.success).toBe(true);
    });

    it("rejects a value that does not appear in its span", () => {
      const r = Claim.safeParse(
        claim({
          ...base,
          field: "employees_estimate",
          value: 1500,
          evidence: {
            kind: "span",
            ref: "https://acme.example/about",
            text: "We employ 1,200 people",
          },
        }),
      );
      expect(r.success).toBe(false);
    });

    it("must be tier 5", () => {
      const r = Claim.safeParse(
        claim({
          ...base,
          source_tier: 3,
          value: "active",
          evidence: { kind: "span", ref: "u", text: "status: active" },
        }),
      );
      expect(r.success).toBe(false);
    });
  });
});

describe("valueAppearsInEvidence", () => {
  it("is case and whitespace insensitive", () => {
    expect(valueAppearsInEvidence("Acme  Widgets", "welcome to ACME widgets ltd")).toBe(true);
  });
  it("checks every leaf of an object value", () => {
    expect(valueAppearsInEvidence({ city: "Bolton", pc: "BL1 1AA" }, "Bolton, BL1 1AA")).toBe(true);
    expect(valueAppearsInEvidence({ city: "Bolton", pc: "M1 1AA" }, "Bolton, BL1 1AA")).toBe(false);
  });
  it("never accepts an empty value", () => {
    expect(valueAppearsInEvidence(null, "anything")).toBe(false);
  });
});

describe("VerifiedFact", () => {
  it("accepts a valid fact", () => {
    expect(VerifiedFact.parse(fact())).toBeTruthy();
  });
  it("requires at least one supporting claim", () => {
    expect(VerifiedFact.safeParse(fact({ supporting_claims: [] })).success).toBe(false);
  });
  it("keeps confidence within 0-1", () => {
    expect(VerifiedFact.safeParse(fact({ confidence: 1.01 })).success).toBe(false);
    expect(VerifiedFact.safeParse(fact({ confidence: -0.1 })).success).toBe(false);
  });
  it("a conflict needs a conflicting claim", () => {
    expect(VerifiedFact.safeParse(fact({ status: "conflict" })).success).toBe(false);
    expect(
      VerifiedFact.safeParse(fact({ status: "conflict", conflicting_claims: [CLAIM_B] })).success,
    ).toBe(true);
  });
  it("a claim cannot both support and conflict", () => {
    expect(VerifiedFact.safeParse(fact({ conflicting_claims: [CLAIM_A] })).success).toBe(false);
  });
  it("expires_at may be null (never expires)", () => {
    expect(VerifiedFact.safeParse(fact({ expires_at: null })).success).toBe(true);
  });
});

describe("combineLanes (guardrail 1: licence inheritance)", () => {
  it("is licensed if any input is licensed", () => {
    expect(combineLanes(["open", "licensed", "open"])).toBe("licensed");
  });
  it("is open when all inputs are open", () => {
    expect(combineLanes(["open", "open"])).toBe("open");
  });
});

describe("getVerifiedFacts params (lane refusal)", () => {
  const base = {
    fields: ["company_status"],
    minConfidence: 0.7,
    asOf: "2026-11-07",
  };

  it("x402 asking for licensed is refused with LaneRefusedError", () => {
    expect(() =>
      parseGetVerifiedFactsParams({ ...base, lanes: ["licensed"], caller: "x402" }),
    ).toThrow(LaneRefusedError);
    expect(() =>
      parseGetVerifiedFactsParams({ ...base, lanes: ["open", "licensed"], caller: "human_check" }),
    ).toThrow(LaneRefusedError);
  });

  it("x402 asking for open is fine and defaults to reconstructed mode", () => {
    const p = parseGetVerifiedFactsParams({ ...base, lanes: ["open"], caller: "x402" });
    expect(p.mode).toBe("reconstructed");
  });

  it("internal callers may ask for licensed", () => {
    expect(
      parseGetVerifiedFactsParams({ ...base, lanes: ["open", "licensed"], caller: "opportunity" }),
    ).toBeTruthy();
  });

  it("rejects malformed asOf and empty fields", () => {
    expect(() =>
      parseGetVerifiedFactsParams({
        ...base,
        asOf: "yesterday",
        lanes: ["open"],
        caller: "internal",
      }),
    ).toThrow();
    expect(() =>
      parseGetVerifiedFactsParams({ ...base, fields: [], lanes: ["open"], caller: "internal" }),
    ).toThrow();
  });

  it("requestVerification needs a reason", () => {
    expect(
      RequestVerificationParams.safeParse({
        entities: ["01234567"],
        fields: ["officers_active"],
        reason: "",
      }).success,
    ).toBe(false);
  });
});

describe("Field registry", () => {
  const def = {
    field: "employees_average",
    description: "Average number of employees from filed accounts",
    value_type: "integer",
    unit: "people",
    tolerance: { kind: "relative", value: 0.1 },
    shelf_life_days: 400,
    half_life_days: 200,
  };
  it("accepts a valid definition", () => {
    expect(FieldDefinition.safeParse(def).success).toBe(true);
  });
  it("half-life must be null exactly when shelf life is null", () => {
    expect(FieldDefinition.safeParse({ ...def, shelf_life_days: null }).success).toBe(false);
    expect(
      FieldDefinition.safeParse({ ...def, shelf_life_days: null, half_life_days: null }).success,
    ).toBe(true);
  });
  it("period-dated fields have no half-life but must have a shelf life", () => {
    expect(
      FieldDefinition.safeParse({ ...def, period_dated: true, half_life_days: null }).success,
    ).toBe(true);
    expect(FieldDefinition.safeParse({ ...def, period_dated: true }).success).toBe(false);
    expect(
      FieldDefinition.safeParse({
        ...def,
        period_dated: true,
        half_life_days: null,
        shelf_life_days: null,
      }).success,
    ).toBe(false);
  });
  it("hold-until-expiry fields have no half-life but must have a shelf life", () => {
    expect(
      FieldDefinition.safeParse({ ...def, hold_until_expiry: true, half_life_days: null }).success,
    ).toBe(true);
    expect(FieldDefinition.safeParse({ ...def, hold_until_expiry: true }).success).toBe(false);
  });
  it("rejects duplicate fields", () => {
    expect(FieldRegistry.safeParse([def, def]).success).toBe(false);
  });
});
