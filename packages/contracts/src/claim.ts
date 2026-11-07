import { z } from "zod";
import {
  CompanyNumber,
  FieldName,
  IsoDateTime,
  Lane,
  Method,
  Slug,
  SourceTier,
  toMillis,
  Uuid,
} from "./common.ts";
import { Evidence, valueAppearsInEvidence } from "./evidence.ts";

export const RawEntityRef = z.object({
  /** The source's own identifier for the entity (CH number, URL, vendor id). */
  source_id: z.string().min(1),
  name: z.string().nullable(),
});

/**
 * A claim: one source saying one thing about one entity at one time.
 * Append-only. Never edited, only superseded.
 *
 * Timestamps:
 * - observed_at: when the source says it became true (effective date).
 * - published_at: when it became knowable (for Companies House: filing received/published).
 *   Point-in-time queries use this.
 * - fetched_at: when we fetched it.
 */
export const Claim = z
  .object({
    claim_id: Uuid,
    entity_id: CompanyNumber.nullable(),
    raw_entity_ref: RawEntityRef,
    field: FieldName,
    value: z.json(),
    source: Slug,
    source_tier: SourceTier,
    lane: Lane,
    method: Method,
    evidence: Evidence.nullable(),
    observed_at: IsoDateTime,
    published_at: IsoDateTime,
    fetched_at: IsoDateTime,
    run_id: Uuid,
  })
  .superRefine((c, ctx) => {
    if (c.method === "llm_extract") {
      if (c.evidence?.kind !== "span") {
        ctx.addIssue({
          code: "custom",
          path: ["evidence"],
          message: "llm_extract claims require a span of evidence",
        });
      } else if (!valueAppearsInEvidence(c.value, c.evidence.text)) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "llm_extract value does not appear in its evidence span",
        });
      }
      if (c.source_tier !== 5) {
        ctx.addIssue({
          code: "custom",
          path: ["source_tier"],
          message: "llm_extract claims are tier 5",
        });
      }
    }
    if (toMillis(c.published_at) > toMillis(c.fetched_at)) {
      ctx.addIssue({
        code: "custom",
        path: ["published_at"],
        message: "published_at cannot be after fetched_at",
      });
    }
  });
export type Claim = z.infer<typeof Claim>;
