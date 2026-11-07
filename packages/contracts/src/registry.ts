import { z } from "zod";
import { FieldName } from "./common.ts";

export const Tolerance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact") }),
  /** e.g. headcount ±10% -> { kind: "relative", value: 0.10 } */
  z.object({ kind: z.literal("relative"), value: z.number().positive().max(1) }),
  z.object({ kind: z.literal("absolute"), value: z.number().positive() }),
]);
export type Tolerance = z.infer<typeof Tolerance>;

export const ValueType = z.enum([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "enum",
  "object",
  "array",
]);

/** One entry in the field registry. shelf_life_days = null means the fact never expires. */
export const FieldDefinition = z
  .object({
    field: FieldName,
    description: z.string().min(1),
    value_type: ValueType,
    unit: z.string().min(1),
    tolerance: Tolerance,
    shelf_life_days: z.number().int().positive().nullable(),
    half_life_days: z.number().positive().nullable(),
  })
  .superRefine((f, ctx) => {
    if ((f.shelf_life_days === null) !== (f.half_life_days === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["half_life_days"],
        message: "half_life_days must be null exactly when shelf_life_days is null",
      });
    }
  });
export type FieldDefinition = z.infer<typeof FieldDefinition>;

export const FieldRegistry = z.array(FieldDefinition).superRefine((defs, ctx) => {
  const seen = new Set<string>();
  for (const [i, d] of defs.entries()) {
    if (seen.has(d.field)) {
      ctx.addIssue({ code: "custom", path: [i, "field"], message: `duplicate field ${d.field}` });
    }
    seen.add(d.field);
  }
});
export type FieldRegistry = z.infer<typeof FieldRegistry>;
