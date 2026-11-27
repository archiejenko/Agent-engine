import { z } from "zod";

/**
 * v4 Phase 1 (PLAN.md §2.2): the vault's market-aware contracts. One canonical business ID across
 * markets, external IDs, contacts with provenance, one signals table, and the source registry.
 */

export const Market = z.enum(["UK", "US"]);
export type Market = z.infer<typeof Market>;

/** UK nations; US states (and DC) as two-letter USPS codes. */
export const UK_REGIONS = ["ENG", "SCO", "WAL", "NIR"] as const;
export const US_REGIONS = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
] as const;
export const Region = z.enum([...UK_REGIONS, ...US_REGIONS]);
export type Region = z.infer<typeof Region>;

export const regionsFor = (m: Market): readonly string[] => (m === "UK" ? UK_REGIONS : US_REGIONS);

/** A region, when present, must belong to the market. */
export const marketRegion = <T extends { market: Market; region?: string | null }>(v: T) =>
  v.region == null || regionsFor(v.market).includes(v.region);

/**
 * Data lanes. `paid_own_use` (decision 1, 2026-11-27): bought under terms that allow our own outreach;
 * may feed our own sends, never an x402 response or a customer report. Facts still use the two-value
 * `Lane` until Phase 2 wires the third lane through the query layer and tool registry.
 */
export const SourceLane = z.enum(["open", "paid_own_use", "licensed"]);
export type SourceLane = z.infer<typeof SourceLane>;

const UK_CH = /^gb-ch:[A-Z0-9]{8}$/;
const US_ENTITY = /^us-[a-z]{2}:[A-Za-z0-9-]{1,40}$/;
const NO_REGISTRY = /^bz:[0-9a-z]{10,40}$/;
export const BusinessId = z
  .string()
  .refine((s) => UK_CH.test(s) || US_ENTITY.test(s) || NO_REGISTRY.test(s), {
    message: "business_id must be gb-ch:<8-char number>, us-<state>:<entity id> or bz:<id>",
  });
export type BusinessId = z.infer<typeof BusinessId>;

/** The canonical ID of a UK company: deterministic, so every existing Companies House row maps 1:1. */
export const ukBusinessId = (companyNumber: string) => `gb-ch:${companyNumber.toUpperCase()}`;
/** The canonical ID of a US state-registry entity. */
export const usBusinessId = (state: string, entityId: string) =>
  `us-${state.toLowerCase()}:${entityId}`;

export const ExternalIdScheme = z.union([
  z.enum(["uk_ch", "sam_uei", "npi", "usdot", "mc", "ein_exempt", "domain", "places_id"]),
  z.string().regex(/^us_state:[A-Z]{2}$/),
]);
export type ExternalIdScheme = z.infer<typeof ExternalIdScheme>;

export const Business = z
  .strictObject({
    business_id: BusinessId,
    name: z.string().min(1),
    name_normalised: z.string().min(1),
    market: Market,
    region: Region.nullable(),
    status: z.string().nullable(),
    company_type: z.string().nullable(),
    industry_code: z.string().nullable(),
    size_band: z.string().nullable(),
    primary_domain: z.string().nullable(),
    merged_into: BusinessId.nullable(),
    source_run_id: z.string().nullable(),
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] })
  .refine((b) => (b.business_id.startsWith("gb-") ? b.market === "UK" : true), {
    message: "a gb-ch business is in the UK market",
    path: ["market"],
  })
  .refine((b) => (b.business_id.startsWith("us-") ? b.market === "US" : true), {
    message: "a us- business is in the US market",
    path: ["market"],
  });
export type Business = z.infer<typeof Business>;

export const ExternalId = z.strictObject({
  business_id: BusinessId,
  scheme: ExternalIdScheme,
  value: z.string().min(1),
  source_id: z.string().min(1),
  confidence: z.number().min(0).max(1),
  fetched_at: z.iso.datetime(),
});
export type ExternalId = z.infer<typeof ExternalId>;

export const Contact = z
  .strictObject({
    contact_id: z.string().min(1),
    business_id: BusinessId,
    kind: z.enum(["role_address", "named_person"]),
    email: z.email().nullable(),
    email_verified: z.enum(["valid", "risky", "invalid", "unknown"]),
    verifier_source_id: z.string().nullable(),
    name: z.string().nullable(),
    title: z.string().nullable(),
    recipient_type: z.enum(["corporate", "sole_trader", "partnership", "unknown"]),
    source_id: z.string().min(1),
    lane: SourceLane,
    confidence: z.number().min(0).max(1),
    market: Market,
    region: Region.nullable(),
    fetched_at: z.iso.datetime(),
    synthetic: z.boolean(),
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] });
export type Contact = z.infer<typeof Contact>;

export const SignalRow = z
  .strictObject({
    signal_key: z.string().min(1),
    kind: z.enum(["engine", "scout"]),
    definition_id: z.string().min(1),
    definition_version: z.number().int().min(0),
    business_id: BusinessId.nullable(),
    problem_id: z.string().nullable(),
    value: z.string().nullable(),
    fact_ids: z.array(z.string()),
    source_id: z.string().nullable(),
    untrusted: z.boolean(),
    market: Market,
    region: Region.nullable(),
    observed_at: z.string().min(1),
    valid_from: z.string().min(1),
    lane: SourceLane,
    run_id: z.string().nullable(),
    synthetic: z.boolean(),
  })
  .refine((s) => s.kind === "engine" || s.untrusted, {
    message: "scout signals come from fetched content: always untrusted",
    path: ["untrusted"],
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] });
export type SignalRow = z.infer<typeof SignalRow>;

/** How a source charges. Amounts in GBP; `assumed` marks a placeholder until the real price is checked. */
export const SourceCostModel = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("free") }),
  z.strictObject({
    kind: z.literal("per_call"),
    gbp: z.number().min(0),
    assumed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("per_record"),
    gbp: z.number().min(0),
    assumed: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("monthly"),
    gbp: z.number().min(0),
    assumed: z.boolean(),
  }),
]);
export type SourceCostModel = z.infer<typeof SourceCostModel>;

/**
 * One source as registered in config (`packages/config/src/sources.json`). Sources are connected
 * lazily: `connected` is runtime state, set only when an approved opportunity needs the source.
 */
export const SourceDefinition = z
  .strictObject({
    source_id: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/),
    name: z.string().min(1),
    market: Market,
    region: Region.nullable(),
    kind: z.enum(["bulk", "api", "scrape", "vendor"]),
    tier: z.number().int().min(1).max(5),
    lane: SourceLane,
    /** `id_only`: store the ID only; re-fetch every other field on demand (e.g. Google Places). */
    retention: z.enum(["full", "id_only"]),
    cost_model: SourceCostModel,
    freshness_target_h: z.number().int().positive(),
    /** Measured later; until then the tier prior applies. */
    reliability: z.number().min(0).max(1).nullable(),
    /** The source's terms. Null only for scraped company websites (each site is its own publisher). */
    terms_url: z.url().nullable(),
    terms_checked_at: z.iso.date().nullable(),
    /** Connected from the start (only sources already in use before v4). */
    connected_by_default: z.boolean(),
    notes: z.string().optional(),
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] })
  .refine((s) => s.terms_url !== null || s.kind === "scrape", {
    message: "every source except scraped websites names its terms",
    path: ["terms_url"],
  })
  .refine((s) => s.lane === "open" || s.cost_model.kind !== "free" || s.kind !== "vendor", {
    message: "a vendor source in a paid lane needs a cost model",
    path: ["cost_model"],
  });
export type SourceDefinition = z.infer<typeof SourceDefinition>;

export const SourceHealth = z.enum(["ok", "degraded", "paused", "schema_drift"]);
export type SourceHealth = z.infer<typeof SourceHealth>;

/** A source as stored: its definition plus runtime state. */
export interface SourceRow {
  source_id: string;
  name: string;
  market: Market;
  region: string | null;
  kind: SourceDefinition["kind"];
  tier: number;
  lane: SourceLane;
  retention: SourceDefinition["retention"];
  cost_model: SourceCostModel;
  freshness_target_h: number;
  reliability: number | null;
  health: SourceHealth;
  schema_hash: string | null;
  connected: boolean;
  connected_at: string | null;
  connected_for: string | null;
  terms_url: string | null;
  terms_checked_at: string | null;
  used_by: string[];
  config_hash: string;
  updated_at: string;
}

export const AuditEntry = z.strictObject({
  audit_id: z.string().min(1),
  at: z.iso.datetime(),
  actor: z.string().regex(/^(node:[a-z0-9_@.-]+|archie|system)$/),
  action: z.string().min(1),
  opportunity_id: z.string().nullable(),
  touch_id: z.string().nullable(),
  recipient_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  basis: z.enum(["corporate_b2b", "consent", "existing_customer"]).nullable(),
  source_ids: z.array(z.string()),
  fact_ids: z.array(z.string()),
  compliance_pack: z.string().nullable(),
  guardrail_hash: z.string().nullable(),
  effect_key: z.string().nullable(),
  market: Market.nullable(),
  dry_run: z.boolean(),
  synthetic: z.boolean(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;
