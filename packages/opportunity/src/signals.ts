import type { SignalDefinition } from "@ae/contracts";
import { clamp01, daysBetween, type FactMap, factId } from "./facts.ts";

/**
 * Signal library (v1). Deterministic functions over verified facts as they stood at `asOf`.
 * Each returns a raw value (or null when the inputs aren't known) and the fact ids it used, plus a
 * normalised 0–1 value. Null signals score neutral (0.5) in modules, so unknowns aren't penalised
 * (Archie's rule for staff_unknown, applied to every signal).
 */
export interface SignalImpl {
  def: SignalDefinition;
  compute(facts: FactMap, asOfMs: number): { value: number | null; fact_ids: string[] };
  normalise(value: number): number;
}

type Item = Record<string, unknown>;
const items = (facts: FactMap, field: string): { list: Item[]; ids: string[] } => {
  const f = facts.get(field);
  return f && Array.isArray(f.value)
    ? { list: f.value as Item[], ids: [factId(f)] }
    : { list: [], ids: [] };
};
const within = (d: unknown, days: number, asOfMs: number) => {
  if (typeof d !== "string") return false;
  const age = daysBetween(d, asOfMs);
  return age >= 0 && age <= days;
};
const def = (signal_id: string, description: string, inputs: string[]): SignalDefinition => ({
  signal_id,
  version: 1,
  description,
  inputs,
  min_input_confidence: 0,
  function: `packages/opportunity/src/signals.ts#${signal_id}`,
});

export const SIGNALS: Record<string, SignalImpl> = {
  filing_health: {
    def: def(
      "filing_health",
      "1 = filings on time. Minus 0.5 if accounts overdue, 0.3 if confirmation statement overdue, 0.2 if no accounts filed in the last 18 months.",
      ["accounts_overdue", "confirmation_statement_overdue", "filing_events"],
    ),
    compute(facts, asOfMs) {
      const acc = facts.get("accounts_overdue");
      const cs = facts.get("confirmation_statement_overdue");
      const ev = items(facts, "filing_events");
      if (!acc && !cs && !facts.has("filing_events")) return { value: null, fact_ids: [] };
      let v = 1;
      if (acc?.value === true) v -= 0.5;
      if (cs?.value === true) v -= 0.3;
      if (
        facts.has("filing_events") &&
        !ev.list.some((f) => f.category === "accounts" && within(f.date, 548, asOfMs))
      )
        v -= 0.2;
      return {
        value: clamp01(v),
        fact_ids: [...(acc ? [factId(acc)] : []), ...(cs ? [factId(cs)] : []), ...ev.ids],
      };
    },
    normalise: (v) => clamp01(v),
  },
  director_change_90d: {
    def: def(
      "director_change_90d",
      "1 if any officer was appointed or resigned in the 90 days before the date.",
      ["officer_appointments"],
    ),
    compute(facts, asOfMs) {
      if (!facts.has("officer_appointments")) return { value: null, fact_ids: [] };
      const { list, ids } = items(facts, "officer_appointments");
      const hit = list.some(
        (o) => within(o.appointed_on, 90, asOfMs) || within(o.resigned_on, 90, asOfMs),
      );
      return { value: hit ? 1 : 0, fact_ids: ids };
    },
    normalise: (v) => v,
  },
  company_age_years: {
    def: def("company_age_years", "Years since incorporation (normalised over 0–20 years).", [
      "incorporation_date",
    ]),
    compute(facts, asOfMs) {
      const f = facts.get("incorporation_date");
      if (!f || typeof f.value !== "string") return { value: null, fact_ids: [] };
      return { value: Math.max(0, daysBetween(f.value, asOfMs) / 365.25), fact_ids: [factId(f)] };
    },
    normalise: (v) => clamp01(v / 20),
  },
  officer_count: {
    def: def("officer_count", "Number of current officers (normalised over 1–10).", [
      "officers_active",
    ]),
    compute(facts) {
      if (!facts.has("officers_active")) return { value: null, fact_ids: [] };
      const { list, ids } = items(facts, "officers_active");
      return { value: list.length, fact_ids: ids };
    },
    normalise: (v) => clamp01((v - 1) / 9),
  },
  new_charge_180d: {
    def: def(
      "new_charge_180d",
      "1 if a new charge (secured borrowing) was created in the last 180 days.",
      ["charges"],
    ),
    compute(facts, asOfMs) {
      if (!facts.has("charges")) return { value: null, fact_ids: [] };
      const { list, ids } = items(facts, "charges");
      return { value: list.some((c) => within(c.created_on, 180, asOfMs)) ? 1 : 0, fact_ids: ids };
    },
    normalise: (v) => v,
  },
  size_band: {
    def: def(
      "size_band",
      "Staff band from filed accounts (5–9: 0.25, 10–24: 0.5, 25–49: 0.75, 50+: 1); falls back to accounts category; unknown is neutral.",
      ["employees_average", "accounts_category"],
    ),
    compute(facts) {
      const e = facts.get("employees_average");
      if (e && typeof e.value === "number") {
        const n = e.value;
        return {
          value: n >= 50 ? 1 : n >= 25 ? 0.75 : n >= 10 ? 0.5 : 0.25,
          fact_ids: [factId(e)],
        };
      }
      const a = facts.get("accounts_category");
      const map: Record<string, number> = {
        "micro-entity": 0.25,
        "total-exemption-full": 0.5,
        "total-exemption-small": 0.5,
        small: 0.5,
        "unaudited-abridged": 0.5,
        "audited-abridged": 0.5,
        medium: 0.75,
        full: 0.75,
        group: 1,
      };
      if (a && typeof a.value === "string" && map[a.value] !== undefined)
        return { value: map[a.value] as number, fact_ids: [factId(a)] };
      return { value: null, fact_ids: [] };
    },
    normalise: (v) => v,
  },
  website_age_years: {
    def: def(
      "website_age_years",
      "Years since the website was last visibly updated (latest of copyright year and Last-Modified). No website at all scores as the oldest (1). Normalised over 0–10 years.",
      ["website_found", "website_copyright_year", "website_last_modified"],
    ),
    compute(facts, asOfMs) {
      const found = facts.get("website_found");
      if (found && found.value === false) return { value: 10, fact_ids: [factId(found)] };
      const cy = facts.get("website_copyright_year");
      const lm = facts.get("website_last_modified");
      const years = [
        ...(cy && typeof cy.value === "number" ? [cy.value] : []),
        ...(lm && typeof lm.value === "string" ? [Number(lm.value.slice(0, 4))] : []),
      ];
      if (!years.length) return { value: null, fact_ids: [] };
      const asOfYear = new Date(asOfMs).getUTCFullYear();
      return {
        value: Math.max(0, asOfYear - Math.max(...years)),
        fact_ids: [
          ...(cy ? [factId(cy)] : []),
          ...(lm ? [factId(lm)] : []),
          ...(found ? [factId(found)] : []),
        ],
      };
    },
    normalise: (v) => clamp01(v / 10),
  },
  hiring_momentum: {
    def: def(
      "hiring_momentum",
      "Number of jobs advertised on the company's website (normalised over 0–5).",
      ["job_postings", "website_found"],
    ),
    compute(facts) {
      const j = facts.get("job_postings");
      if (j && Array.isArray(j.value)) return { value: j.value.length, fact_ids: [factId(j)] };
      const found = facts.get("website_found");
      // A website we've read with no careers listing: zero jobs (known). No website / unknown: null.
      if (found?.value === true && facts.has("website_copyright_year"))
        return { value: 0, fact_ids: [factId(found)] };
      return { value: null, fact_ids: [] };
    },
    normalise: (v) => clamp01(v / 5),
  },
  ownership_change_180d: {
    def: def(
      "ownership_change_180d",
      "1 if a person with significant control was added or removed in the last 180 days.",
      ["psc_history"],
    ),
    compute(facts, asOfMs) {
      if (!facts.has("psc_history")) return { value: null, fact_ids: [] };
      const { list, ids } = items(facts, "psc_history");
      return {
        value: list.some(
          (p) => within(p.notified_on, 180, asOfMs) || within(p.ceased_on, 180, asOfMs),
        )
          ? 1
          : 0,
        fact_ids: ids,
      };
    },
    normalise: (v) => v,
  },
};

export function signalInputs(ids: string[]): string[] {
  return [...new Set(ids.flatMap((id) => SIGNALS[id]?.def.inputs ?? []))].sort();
}
