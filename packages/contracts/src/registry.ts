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
    /**
     * Period-dated facts describe a fixed period (e.g. headcount in filed accounts). They don't decay:
     * they don't become less true with age. They still go stale after shelf_life_days, when a newer
     * period's figure should exist.
     */
    period_dated: z.boolean().default(false),
    /**
     * Site-level facts (a website exists, when it was last updated, its tech, its contact routes) hold
     * their confidence for the whole shelf life and then go stale, instead of decaying from day one.
     * A website doesn't become gradually less likely to exist; it's either been re-checked or it hasn't.
     */
    hold_until_expiry: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if (f.period_dated || f.hold_until_expiry) {
      const kind = f.period_dated ? "period-dated" : "hold-until-expiry";
      if (f.half_life_days !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["half_life_days"],
          message: `${kind} facts don't decay: half_life_days must be null`,
        });
      }
      if (f.shelf_life_days === null) {
        ctx.addIssue({
          code: "custom",
          path: ["shelf_life_days"],
          message: `${kind} facts need a shelf life (when they go stale)`,
        });
      }
    } else if ((f.shelf_life_days === null) !== (f.half_life_days === null)) {
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
