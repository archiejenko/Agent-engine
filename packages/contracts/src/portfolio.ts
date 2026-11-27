import { z } from "zod";
import { Market, marketRegion, Region, SourceLane } from "./vault.ts";

/**
 * v4 Phase 1 (PLAN.md §2.1): Opportunity = Problem × Segment × Route × Channel. The opportunity
 * config that Archie signs (budget, stages, kill rules, arms) is Phase 4; here `config` is stored as JSON
 * and hashed.
 */

export const RouteId = z.enum([
  "service_retainer",
  "productised_tool",
  "x402_api",
  "marketplace_gig",
  "digital_product",
]);
export type RouteId = z.infer<typeof RouteId>;

export const ChannelId = z.enum([
  "cold_email",
  "marketplace_listing",
  "seo_pages",
  "agent_directory",
  "x_content",
  "partnership",
]);
export type ChannelId = z.infer<typeof ChannelId>;

export const Stage = z.enum([
  "sense",
  "hypothesise",
  "size",
  "smoke_test",
  "build_minimum",
  "distribute",
  "serve",
  "measure",
  "scale",
  "killed",
  "spawned",
]);
export type Stage = z.infer<typeof Stage>;

export const Bucket = z.enum(["exploit", "adjacent", "explore"]);
export type Bucket = z.infer<typeof Bucket>;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9_]{0,79}$/);

/** The internal industry list (config `industries.json`), mapped to UK SIC 2007 and US NAICS 2022. */
export const Industry = z
  .strictObject({
    code: Slug,
    name: z.string().min(1),
    /** True for the one "all SMEs" entry: problems that aren't specific to an industry. */
    cross_industry: z.boolean().default(false),
    /** SIC 2007 two-digit divisions (UK). */
    sic_divisions: z.array(z.string().regex(/^\d{2}$/)),
    /** NAICS 2022 two-digit sectors (US); 31-33, 44-45, 48-49 are written as their first code. */
    naics_sectors: z.array(z.string().regex(/^\d{2}$/)),
  })
  .refine((i) => i.cross_industry || (i.sic_divisions.length > 0 && i.naics_sectors.length > 0), {
    message: "an industry maps to at least one SIC division and one NAICS sector",
  });
export type Industry = z.infer<typeof Industry>;

export const IndustriesConfig = z
  .strictObject({
    version: z.number().int().positive(),
    /** The mapping is coarse (division ↔ sector) and assumed until checked against the ONS/Census tables. */
    assumed: z.boolean(),
    industries: z.array(Industry).min(1),
    /** The category in the seed ideas (`hypotheses.category`) → industry code. */
    seed_category_industry: z.record(z.string().min(1), Slug),
  })
  .superRefine((c, ctx) => {
    const codes = new Set<string>();
    for (const i of c.industries) {
      if (codes.has(i.code))
        ctx.addIssue({
          code: "custom",
          message: `duplicate industry ${i.code}`,
          path: ["industries"],
        });
      codes.add(i.code);
    }
    for (const [cat, code] of Object.entries(c.seed_category_industry))
      if (!codes.has(code))
        ctx.addIssue({
          code: "custom",
          message: `category ${cat} maps to unknown industry ${code}`,
          path: ["seed_category_industry", cat],
        });
  });
export type IndustriesConfig = z.infer<typeof IndustriesConfig>;

export const Problem = z.strictObject({
  problem_id: z.string().regex(/^prb_[a-z0-9_]{1,80}$/),
  industry_code: Slug,
  function: z.string().min(1),
  problem_slug: Slug,
  statement: z.string().min(1).max(500),
  evidence_fact_ids: z.array(z.string()),
  evidence_strength: z.number().min(0).max(1),
  status: z.enum(["sensed", "evidenced", "retired"]),
  markets_seen: z.array(Market),
  seed_hypothesis_ids: z.array(z.string()),
  source: z.string().min(1),
  synthetic: z.boolean(),
});
export type Problem = z.infer<typeof Problem>;

export const Segment = z
  .strictObject({
    segment_id: z.string().regex(/^seg_[a-z0-9_]{1,80}$/),
    market: Market,
    region: Region.nullable(),
    industry_code: Slug.nullable(),
    size_band: z.string().nullable(),
    filters: z.record(z.string(), z.unknown()),
    est_population: z.number().int().min(0).nullable(),
    population_source: z.string().nullable(),
    as_of: z.iso.datetime(),
    synthetic: z.boolean(),
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] });
export type Segment = z.infer<typeof Segment>;

export const Route = z.strictObject({
  route_id: RouteId,
  template_graph: z.string().nullable(),
  default_stage_caps: z.partialRecord(Stage, z.number().min(0)),
  cost_to_serve_model: z.record(z.string(), z.unknown()),
  status: z.enum(["active", "planned", "retired"]),
});
export type Route = z.infer<typeof Route>;

export const Channel = z.strictObject({
  channel_id: ChannelId,
  template_graph: z.string().nullable(),
  allowed_markets: z.array(Market),
  compliance_pack_ids: z.array(z.string()),
  status: z.enum(["active", "planned", "retired"]),
});
export type Channel = z.infer<typeof Channel>;

/** Routes and channels as registered in config (`portfolio.json`). */
export const PortfolioConfig = z.strictObject({
  version: z.number().int().positive(),
  routes: z.array(Route).min(1),
  channels: z.array(Channel).min(1),
});
export type PortfolioConfig = z.infer<typeof PortfolioConfig>;

export const PortfolioStatus = z.enum([
  "proposed",
  "approved",
  "running",
  "paused",
  "scaled",
  "killed",
]);

export const OpportunityRow = z
  .strictObject({
    opportunity_id: z.string().regex(/^opp_[a-z0-9_]{1,80}$/),
    version: z.number().int().positive(),
    problem_id: z.string().min(1),
    segment_id: z.string().min(1),
    route_id: RouteId,
    channel_id: ChannelId,
    market: Market,
    region: Region.nullable(),
    stage: Stage,
    bucket: Bucket,
    config: z.record(z.string(), z.unknown()),
    config_hash: z.string().regex(/^[0-9a-f]{12,64}$/),
    compiled_graph: z.string().nullable(),
    lane: SourceLane,
    parent_opportunity_id: z.string().nullable(),
    hypothesis_id: z.string().nullable(),
    status: PortfolioStatus,
    approval_id: z.string().nullable(),
    spend_gbp: z.number().min(0),
    revenue_gbp: z.number().min(0),
    observed_cac_gbp: z.number().min(0).nullable(),
    observed_cost_to_serve_gbp: z.number().min(0).nullable(),
    synthetic: z.boolean(),
  })
  .refine(marketRegion, { message: "region doesn't belong to market", path: ["region"] })
  .refine((o) => !["approved", "running", "scaled"].includes(o.status) || o.approval_id !== null, {
    message: "an approved opportunity carries Archie's approval (the signed contract)",
    path: ["approval_id"],
  });
export type OpportunityRow = z.infer<typeof OpportunityRow>;
