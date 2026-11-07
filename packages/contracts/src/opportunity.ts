import { z } from "zod";
import {
  CompanyNumber,
  FieldName,
  Gbp,
  IsoDateOrDateTime,
  IsoDateTime,
  Lane,
  Probability,
  Slug,
  Uuid,
} from "./common.ts";

const WEIGHT_SUM_TOLERANCE = 1e-6;

export const SignalDefinition = z.object({
  signal_id: Slug,
  version: z.number().int().positive(),
  description: z.string().min(1),
  inputs: z.array(FieldName).min(1),
  min_input_confidence: Probability,
  /** Name of the deterministic implementation (TS function or SQL file). */
  function: z.string().min(1),
});
export type SignalDefinition = z.infer<typeof SignalDefinition>;

export const SignalValue = z.object({
  signal_id: Slug,
  signal_version: z.number().int().positive(),
  entity_id: CompanyNumber,
  as_of: IsoDateOrDateTime,
  value: z.number().finite().nullable(), // null = could not compute (e.g. staff_unknown)
  fact_ids: z.array(z.string().min(1)),
});
export type SignalValue = z.infer<typeof SignalValue>;

export const ModuleSignalConfig = z.object({
  weight: z.number().min(0).max(1),
  invert: z.boolean().default(false),
});

/** YAML front matter of a note in brain/frameworks/. */
export const ModuleConfig = z
  .object({
    module: Slug,
    version: z.number().int().positive(),
    universe: z.record(z.string(), z.json()),
    lanes: z.array(Lane).min(1),
    confidence_floor: Probability,
    signals: z.record(Slug, ModuleSignalConfig),
    threshold: Probability,
    outcome: z.object({
      event: Slug,
      window_days: z.number().int().positive(),
      value_field: Slug,
    }),
    explore_share: z.number().min(0).max(0.5),
  })
  .superRefine((m, ctx) => {
    const weights = Object.values(m.signals).map((s) => s.weight);
    if (weights.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["signals"],
        message: "at least one signal is required",
      });
      return;
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        path: ["signals"],
        message: `signal weights must sum to 1 (got ${sum.toFixed(4)})`,
      });
    }
  });
export type ModuleConfig = z.infer<typeof ModuleConfig>;

export const TraceItem = z.object({
  signal_id: Slug,
  signal_version: z.number().int().positive(),
  raw_value: z.number().finite().nullable(),
  normalised: Probability,
  weight: z.number().min(0).max(1),
  contribution: z.number().min(0).max(1),
  fact_ids: z.array(z.string().min(1)),
});
export type TraceItem = z.infer<typeof TraceItem>;

export const OpportunityStatus = z.enum(["proposed", "approved", "rejected", "actioned"]);

export const Opportunity = z
  .object({
    opportunity_id: Uuid,
    module: Slug,
    module_version: z.number().int().positive(),
    note_hash: z.string().regex(/^[a-f0-9]{64}$/, "sha256 hex"),
    entity_id: CompanyNumber,
    as_of: IsoDateOrDateTime,
    score: Probability,
    expected_value_gbp: Gbp,
    confidence: Probability,
    trace: z.array(TraceItem).min(1),
    lane: Lane,
    explore: z.boolean(),
    status: OpportunityStatus,
  })
  .superRefine((o, ctx) => {
    for (const [i, t] of o.trace.entries()) {
      if (Math.abs(t.contribution - t.weight * t.normalised) > 1e-9) {
        ctx.addIssue({
          code: "custom",
          path: ["trace", i, "contribution"],
          message: "contribution must equal weight × normalised",
        });
      }
    }
    const total = o.trace.reduce((a, t) => a + t.contribution, 0);
    if (Math.abs(total - o.score) > 1e-9) {
      ctx.addIssue({
        code: "custom",
        path: ["score"],
        message: "score must equal the sum of trace contributions",
      });
    }
  });
export type Opportunity = z.infer<typeof Opportunity>;

export const Outcome = z.object({
  opportunity_id: Uuid,
  event: Slug,
  value: z.union([z.boolean(), Gbp]),
  observed_at: IsoDateTime,
  source: z.enum(["human", "system", "verified_fact"]),
});
export type Outcome = z.infer<typeof Outcome>;
