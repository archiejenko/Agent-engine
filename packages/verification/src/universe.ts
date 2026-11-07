import type { UniverseConfig } from "@ae/contracts";
import type { EntityRow, UniverseMember } from "@ae/storage";

/**
 * Universe rules (all from config, approved 2026-11-07):
 * active · not dormant · registered office in a listed borough · not ONLY excluded SIC codes ·
 * 5–100 staff where known; unknown staff stays in, flagged staff_unknown.
 */
export function decideCandidate(
  e: EntityRow,
  u: UniverseConfig,
): Omit<UniverseMember, "universe" | "entity_id"> {
  if (!e.lad_code || !u.region.lad_codes.includes(e.lad_code)) {
    return { included: false, reason: "outside_region", staff_flag: "not_checked" };
  }
  if (!e.company_status || !u.company_status.includes(e.company_status)) {
    return {
      included: false,
      reason: `status_${e.company_status ?? "unknown"}`,
      staff_flag: "not_checked",
    };
  }
  if (u.exclude_dormant && (e.accounts_category === "dormant" || e.sic_codes.includes("99999"))) {
    return { included: false, reason: "dormant", staff_flag: "not_checked" };
  }
  const excluded = new Set(u.sic_exclude.map((s) => s.code));
  if (e.sic_codes.length > 0 && e.sic_codes.every((c) => excluded.has(c))) {
    return { included: false, reason: "sic_excluded", staff_flag: "not_checked" };
  }
  return { included: true, reason: "candidate", staff_flag: "not_checked" };
}

export function decideStaff(
  employees: number | null,
  u: UniverseConfig,
): Omit<UniverseMember, "universe" | "entity_id"> {
  if (employees === null) {
    return u.staff.unknown_policy === "include_flagged"
      ? { included: true, reason: "in_universe_staff_unknown", staff_flag: "staff_unknown" }
      : { included: false, reason: "staff_unknown_excluded", staff_flag: "staff_unknown" };
  }
  if (employees < u.staff.min)
    return { included: false, reason: "staff_below_min", staff_flag: "known" };
  if (employees > u.staff.max)
    return { included: false, reason: "staff_above_max", staff_flag: "known" };
  return { included: true, reason: "in_universe", staff_flag: "known" };
}
