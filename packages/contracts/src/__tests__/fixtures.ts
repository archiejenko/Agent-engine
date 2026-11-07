import type { Claim, VerifiedFact } from "../index.ts";

export const RUN_ID = "0b6f7f0e-6b1a-4c55-9a8e-2f5d8f1b9a01";
export const CLAIM_A = "6f1c2a4e-1d2b-4e3f-8a9b-0c1d2e3f4a5b";
export const CLAIM_B = "7a2d3b5f-2e3c-4f4a-9b0c-1d2e3f4a5b6c";

export function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    claim_id: CLAIM_A,
    entity_id: "01234567",
    raw_entity_ref: { source_id: "01234567", name: "ACME WIDGETS LTD" },
    field: "company_status",
    value: "active",
    source: "companies_house",
    source_tier: 1,
    lane: "open",
    method: "api",
    evidence: {
      kind: "record",
      ref: "https://api.company-information.service.gov.uk/company/01234567",
    },
    observed_at: "2026-10-01T00:00:00Z",
    published_at: "2026-10-02T00:00:00Z",
    fetched_at: "2026-11-07T09:00:00Z",
    run_id: RUN_ID,
    ...overrides,
  };
}

export function fact(overrides: Partial<VerifiedFact> = {}): VerifiedFact {
  return {
    entity_id: "01234567",
    field: "company_status",
    value: "active",
    confidence: 0.93,
    supporting_claims: [CLAIM_A],
    conflicting_claims: [],
    lane: "open",
    valid_from: "2026-10-02T00:00:00Z",
    first_observed_at: "2026-10-01T00:00:00Z",
    last_verified_at: "2026-11-07T09:00:00Z",
    expires_at: "2026-11-14T09:00:00Z",
    status: "verified",
    ...overrides,
  };
}
