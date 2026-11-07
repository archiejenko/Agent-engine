import { z } from "zod";
import {
  CompanyNumber,
  FieldName,
  IsoDateOrDateTime,
  IsoDateTime,
  Lane,
  Probability,
} from "./common.ts";

/** Who is asking. Determines which lanes are allowed. */
export const Caller = z.enum([
  "opportunity",
  "playbook",
  "x402",
  "human_check",
  "dashboard",
  "internal",
]);
export type Caller = z.infer<typeof Caller>;

/** Callers that serve customers directly. Hard-wired to the open lane (section 3.4). */
export const OPEN_ONLY_CALLERS: readonly Caller[] = ["x402", "human_check"];

export class LaneRefusedError extends Error {
  constructor(caller: Caller) {
    super(`caller "${caller}" may only read open-lane facts; licensed lane refused`);
    this.name = "LaneRefusedError";
  }
}

export const Filter = z.object({
  field: FieldName,
  op: z.enum(["eq", "in", "gte", "lte", "between"]),
  value: z.json(),
});
export type Filter = z.infer<typeof Filter>;

/**
 * Point-in-time modes:
 * - reconstructed (default): facts with valid_from <= asOf (valid_from = when the source published it).
 * - strict: additionally only what we had actually recorded by asOf (no hindsight).
 */
export const PointInTimeMode = z.enum(["reconstructed", "strict"]);

export const GetVerifiedFactsParams = z
  .object({
    entities: z
      .union([z.array(CompanyNumber).min(1), z.object({ filters: z.array(Filter) })])
      .optional(),
    fields: z.array(FieldName).min(1),
    minConfidence: Probability,
    asOf: IsoDateOrDateTime,
    lanes: z.array(Lane).min(1),
    caller: Caller,
    mode: PointInTimeMode.default("reconstructed"),
  })
  .superRefine((p, ctx) => {
    if (OPEN_ONLY_CALLERS.includes(p.caller) && p.lanes.includes("licensed")) {
      ctx.addIssue({
        code: "custom",
        path: ["lanes"],
        message: `caller "${p.caller}" may only read open-lane facts`,
      });
    }
  });
export type GetVerifiedFactsParams = z.input<typeof GetVerifiedFactsParams>;

/**
 * Parse query params, throwing LaneRefusedError (not a generic validation error) for a lane breach,
 * so callers and logs can tell a guardrail refusal apart from a malformed request.
 */
export function parseGetVerifiedFactsParams(
  input: unknown,
): z.output<typeof GetVerifiedFactsParams> {
  const loose = z.object({ caller: Caller, lanes: z.array(Lane) }).safeParse(input);
  if (
    loose.success &&
    OPEN_ONLY_CALLERS.includes(loose.data.caller) &&
    loose.data.lanes.includes("licensed")
  ) {
    throw new LaneRefusedError(loose.data.caller);
  }
  return GetVerifiedFactsParams.parse(input);
}

export const RequestVerificationParams = z.object({
  entities: z.array(CompanyNumber).min(1),
  fields: z.array(FieldName).min(1),
  reason: z.string().min(1),
  deadline: IsoDateTime.optional(),
});
export type RequestVerificationParams = z.infer<typeof RequestVerificationParams>;
