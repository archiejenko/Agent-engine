import {
  ConfidenceConfig,
  type FieldDefinition,
  FieldRegistry,
  UniverseConfig,
} from "@ae/contracts";
import { z } from "zod";
import chJson from "./companies_house.json" with { type: "json" };
import confidenceJson from "./confidence.json" with { type: "json" };
import registryJson from "./field-registry.json" with { type: "json" };
import universeJson from "./universe.lead_gen.json" with { type: "json" };
import verificationJson from "./verification.json" with { type: "json" };

/**
 * Config is data, not code. Each file is validated on load; an invalid file stops the program
 * rather than running with a guessed value.
 */
export function loadUniverseConfig(raw: unknown = universeJson): UniverseConfig {
  return UniverseConfig.parse(raw);
}

export function loadConfidenceConfig(raw: unknown = confidenceJson): ConfidenceConfig {
  return ConfidenceConfig.parse(raw);
}

/** True if a company with these SIC codes is excluded from the universe. */
export function isSicExcluded(sicCodes: readonly string[], universe: UniverseConfig): boolean {
  const excluded = new Set(universe.sic_exclude.map((s) => s.code));
  // A company is excluded only if ALL its SIC codes are excluded ones; a trading company that
  // also lists a holding-company code is kept.
  return sicCodes.length > 0 && sicCodes.every((c) => excluded.has(c));
}

export function loadConfidenceConfigChecked(raw?: unknown): ConfidenceConfig {
  const c = loadConfidenceConfig(raw);
  for (const [name, src] of Object.entries(c.sources)) {
    if (src.lane === "licensed")
      throw new Error(`source ${name} is licensed; no licensed data in this build`);
  }
  return c;
}

/** The field registry as a map. Unknown fields are not in it and must be dropped, never guessed. */
export function loadFieldRegistry(raw: unknown = registryJson): Map<string, FieldDefinition> {
  const defs = FieldRegistry.parse(raw);
  return new Map(defs.map((d) => [d.field, d]));
}

/** Short fingerprint of a config object, recorded on every run (reproducibility). */
export async function configVersion(obj: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const VerificationConfig = z.object({
  triangulation: z.object({ clear_margin: z.number().min(0).max(1) }),
  sanity: z.object({
    max_employees: z.number().int().positive(),
    revenue_per_employee_gbp: z.object({ min: z.number().positive(), max: z.number().positive() }),
  }),
  resolution: z.object({
    weights: z.object({
      name: z.number().min(0),
      postcode: z.number().min(0),
      domain: z.number().min(0),
    }),
    auto_match: z.number().min(0).max(1),
    adjudicate: z.number().min(0).max(1),
  }),
});
export type VerificationConfig = z.infer<typeof VerificationConfig>;

export function loadVerificationConfig(raw: unknown = verificationJson): VerificationConfig {
  const c = VerificationConfig.parse(raw);
  if (c.resolution.adjudicate > c.resolution.auto_match) {
    throw new Error("resolution.adjudicate must be <= resolution.auto_match");
  }
  return c;
}

export const CompaniesHouseConfig = z.object({
  api_base_url: z.url(),
  rate_limit: z.object({
    requests: z.number().int().positive(),
    window_seconds: z.number().int().positive(),
    /** Share of the documented limit we actually use, leaving headroom. */
    use_share: z.number().gt(0).max(1),
  }),
  items_per_page: z.number().int().min(1).max(100),
  max_pages: z.number().int().positive(),
  max_retries: z.number().int().min(0),
  /** How many years of officer/filing/charge/PSC history to keep in snapshots. */
  history_years: z.number().int().positive(),
  /** Filing history is the bulkiest field, so it keeps a shorter window. */
  filing_history_years: z.number().int().positive(),
  fetch_charges_only_if_flagged: z.boolean(),
});
export type CompaniesHouseConfig = z.infer<typeof CompaniesHouseConfig>;

export function loadCompaniesHouseConfig(raw: unknown = chJson): CompaniesHouseConfig {
  return CompaniesHouseConfig.parse(raw);
}

export const rawConfig = {
  companies_house: chJson,
  universe: universeJson,
  confidence: confidenceJson,
  registry: registryJson,
  verification: verificationJson,
};
