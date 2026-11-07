import { z } from "zod";
import {
  CompanyNumber,
  FieldName,
  IsoDateTime,
  Lane,
  Probability,
  toMillis,
  Uuid,
} from "./common.ts";

export const FactStatus = z.enum(["verified", "conflict", "stale", "quarantined"]);
export type FactStatus = z.infer<typeof FactStatus>;

/**
 * A verified fact: the engine's current answer for one entity + field.
 * - valid_from: earliest supporting published_at (when it became knowable). Used for point-in-time.
 * - first_observed_at: earliest supporting observed_at (first time a source asserted it).
 */
export const VerifiedFact = z
  .object({
    entity_id: CompanyNumber,
    field: FieldName,
    value: z.json(),
    confidence: Probability,
    supporting_claims: z.array(Uuid).min(1),
    conflicting_claims: z.array(Uuid),
    lane: Lane,
    valid_from: IsoDateTime,
    first_observed_at: IsoDateTime,
    last_verified_at: IsoDateTime,
    expires_at: IsoDateTime.nullable(),
    status: FactStatus,
  })
  .superRefine((f, ctx) => {
    if (f.status === "conflict" && f.conflicting_claims.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicting_claims"],
        message: "a conflict needs at least one conflicting claim",
      });
    }
    const overlap = f.supporting_claims.filter((id) => f.conflicting_claims.includes(id));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["conflicting_claims"],
        message: "a claim cannot both support and conflict",
      });
    }
    if (toMillis(f.valid_from) > toMillis(f.last_verified_at)) {
      ctx.addIssue({
        code: "custom",
        path: ["valid_from"],
        message: "valid_from cannot be after last_verified_at",
      });
    }
  });
export type VerifiedFact = z.infer<typeof VerifiedFact>;

/** One historical version of a fact. recorded_at = when WE wrote it (used by strict point-in-time). */
export const VerifiedFactVersion = z.object({
  fact: VerifiedFact,
  version: z.number().int().positive(),
  recorded_at: IsoDateTime,
  run_id: Uuid,
});
export type VerifiedFactVersion = z.infer<typeof VerifiedFactVersion>;
