import type { VerifiedFact } from "@ae/contracts";

/** A fact's id in traces: entity/field/valid_from. Unique for a fact state; traceable to its claims. */
export const factId = (f: VerifiedFact) => `${f.entity_id}/${f.field}/${f.valid_from}`;

export type FactMap = Map<string, VerifiedFact>;

const DAY = 86_400_000;
export const daysBetween = (aIso: string, bMs: number) =>
  (bMs - Date.parse(aIso.length === 10 ? `${aIso}T00:00:00Z` : aIso)) / DAY;
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
