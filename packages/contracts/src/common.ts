import { z } from "zod";

/** ISO 8601 timestamp with timezone, e.g. 2026-11-07T09:30:00Z */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** ISO calendar date, e.g. 2026-11-07 */
export const IsoDate = z.iso.date();
/** Either a date or a timestamp. Used for `asOf`. */
export const IsoDateOrDateTime = z.union([IsoDate, IsoDateTime]);

export const Uuid = z.uuid();

/** Companies House company number: 8 characters, digits or a 2-letter prefix (SC, NI, OC...). */
export const CompanyNumber = z
  .string()
  .regex(/^(?:\d{8}|[A-Z]{2}\d{6}|R\d{7})$/, "not a valid Companies House number");

/** Canonical field name from the field registry: snake_case. */
export const FieldName = z.string().regex(/^[a-z][a-z0-9_]*$/, "field names are snake_case");
/** Slug used for sources, modules, signals, playbooks, tools. */
export const Slug = z.string().regex(/^[a-z][a-z0-9_]*$/, "must be a snake_case slug");

export const Lane = z.enum(["open", "licensed"]);
export type Lane = z.infer<typeof Lane>;

/** 1 statutory filing · 2 regulator register · 3 company's own disclosure · 4 vendor estimate · 5 LLM extraction */
export const SourceTier = z.number().int().min(1).max(5);

export const Method = z.enum(["api", "bulk_file", "scrape", "llm_extract", "human"]);
export type Method = z.infer<typeof Method>;

export const Probability = z.number().min(0).max(1);
export const Gbp = z.number().finite().nonnegative();

/**
 * Licence lane inheritance (guardrail 1): anything built from a licensed input is licensed.
 */
export function combineLanes(lanes: readonly Lane[]): Lane {
  return lanes.includes("licensed") ? "licensed" : "open";
}

/** Milliseconds since epoch for an ISO date or datetime (dates are read as UTC midnight). */
export function toMillis(iso: string): number {
  return Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
}
