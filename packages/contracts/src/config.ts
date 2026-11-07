import { z } from "zod";

/** ONS local authority district code, e.g. E08000003 (Manchester). */
export const LadCode = z.string().regex(/^[EWSN]\d{8}$/);
export const SicCode = z.string().regex(/^\d{5}$/);

export const UniverseConfig = z.object({
  name: z.string().min(1),
  region: z.object({
    name: z.string().min(1),
    lad_codes: z.array(LadCode).min(1),
    lad_names: z.record(LadCode, z.string()),
  }),
  company_status: z.array(z.string().min(1)).min(1),
  exclude_dormant: z.boolean(),
  staff: z.object({
    min: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    /** include_flagged: unknown staff numbers stay in, flagged staff_unknown, scored neutral on size. */
    unknown_policy: z.enum(["include_flagged", "exclude"]),
  }),
  sic_exclude: z.array(z.object({ code: SicCode, reason: z.string().min(1) })),
  sic_keep_notes: z.array(z.object({ code: SicCode, reason: z.string().min(1) })).default([]),
  location_basis: z.enum(["registered_office", "trading_address"]),
});
export type UniverseConfig = z.infer<typeof UniverseConfig>;

export const ConfidenceConfig = z.object({
  /** Default reliability r per source tier, used until measured reliability replaces it. */
  tier_priors: z.object({
    "1": z.number().min(0).max(1),
    "2": z.number().min(0).max(1),
    "3": z.number().min(0).max(1),
    "4": z.number().min(0).max(1),
    "5": z.number().min(0).max(1),
  }),
  /** λ, the conflict penalty in confidence v1. */
  conflict_penalty_lambda: z.number().min(0),
});
export type ConfidenceConfig = z.infer<typeof ConfidenceConfig>;
