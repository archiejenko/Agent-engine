import { ConfidenceConfig, UniverseConfig } from "@ae/contracts";
import confidenceJson from "./confidence.json" with { type: "json" };
import universeJson from "./universe.lead_gen.json" with { type: "json" };

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
