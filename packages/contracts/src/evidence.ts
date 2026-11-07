import { z } from "zod";

/**
 * Evidence for a claim.
 * - `record`: a pointer to a structured record (API URL, bulk file row id).
 * - `span`: the exact text the value was taken from (required for llm_extract).
 */
export const Evidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), ref: z.string().min(1) }),
  z.object({ kind: z.literal("span"), ref: z.string().min(1), text: z.string().min(1) }),
]);
export type Evidence = z.infer<typeof Evidence>;

function normaliseText(s: string): string {
  return s
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 1,200 -> 1200
    .replace(/\s+/g, " ")
    .trim();
}

function leaves(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(leaves);
  return [];
}

/**
 * Guardrail 3 (truthfulness): an llm_extract claim's value must literally appear in its evidence span.
 * Every primitive leaf of the value must be found in the span (case- and whitespace-insensitive,
 * thousands separators ignored). Booleans are exempt because they are judgements, not quotes.
 */
export function valueAppearsInEvidence(value: unknown, spanText: string): boolean {
  const haystack = normaliseText(spanText);
  const needles = leaves(value).filter((v) => v !== "true" && v !== "false");
  if (needles.length === 0) return false;
  return needles.every((n) => haystack.includes(normaliseText(n)));
}
