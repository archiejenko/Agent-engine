import type { VerificationConfig } from "@ae/config";
import { type Claim, toMillis } from "@ae/contracts";

/**
 * Deterministic sanity rules, run before anything becomes a fact (and before any model call).
 * A failing claim is stored with the rule that failed and never becomes a fact.
 */
export interface SanityFailure {
  claim_id: string;
  rule: string;
  detail: string;
}

/** What we already believe about the entity (from this batch or current facts). */
export interface EntityContext {
  incorporation_date?: string | null;
  company_status?: string | null;
  dissolution_date?: string | null;
  employees_average?: number | null;
  turnover_gbp?: number | null;
}

type Rule = (c: Claim, e: EntityContext, cfg: VerificationConfig["sanity"]) => string | null;

const asArray = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? (v.filter((x) => x && typeof x === "object") as Record<string, unknown>[])
    : [];
const dateMs = (v: unknown): number | null =>
  typeof v === "string" && !Number.isNaN(toMillis(v)) ? toMillis(v) : null;

export const RULES: Record<string, Rule> = {
  incorporation_date_in_future: (c) => {
    if (c.field !== "incorporation_date") return null;
    const d = dateMs(c.value);
    return d !== null && d > toMillis(c.fetched_at)
      ? `incorporation date ${String(c.value)} is after the fetch date`
      : null;
  },

  negative_value: (c) => {
    if (typeof c.value === "number" && c.value < 0)
      return `negative value ${c.value} for ${c.field}`;
    return null;
  },

  employees_implausible: (c, _e, cfg) => {
    if (c.field !== "employees_average" || typeof c.value !== "number") return null;
    if (!Number.isInteger(c.value)) return `employee count ${c.value} is not a whole number`;
    return c.value > cfg.max_employees
      ? `employee count ${c.value} exceeds ${cfg.max_employees}`
      : null;
  },

  revenue_per_employee_out_of_band: (c, e, cfg) => {
    const pair =
      c.field === "employees_average" && typeof c.value === "number"
        ? { emp: c.value, rev: e.turnover_gbp }
        : c.field === "turnover_gbp" && typeof c.value === "number"
          ? { emp: e.employees_average, rev: c.value }
          : null;
    if (!pair?.emp || pair.rev === null || pair.rev === undefined) return null;
    const rpe = pair.rev / pair.emp;
    const { min, max } = cfg.revenue_per_employee_gbp;
    return rpe < min || rpe > max
      ? `revenue per employee £${Math.round(rpe)} outside £${min}-£${max}`
      : null;
  },

  dissolved_with_new_filings: (c, e) => {
    if (c.field !== "filing_events") return null;
    const dissolved = dateMs(e.dissolution_date);
    if (dissolved === null || e.company_status !== "dissolved") return null;
    const late = asArray(c.value).filter((f) => {
      const d = dateMs(f.date);
      const type = String(f.type ?? "");
      // Restoration and dissolution paperwork legitimately follow dissolution.
      return d !== null && d > dissolved && !/^(RT01|AC92|RESTORATION|GAZ2|DS01|GAZ1)/i.test(type);
    });
    return late.length
      ? `${late.length} filing(s) dated after dissolution on ${e.dissolution_date}`
      : null;
  },

  officer_appointed_before_birth: (c) => {
    if (c.field !== "officers_active" && c.field !== "officer_appointments") return null;
    const bad = asArray(c.value).filter((o) => {
      const year = Number((o.date_of_birth as { year?: number } | undefined)?.year);
      const appointed = dateMs(o.appointed_on);
      return (
        Number.isFinite(year) && appointed !== null && new Date(appointed).getUTCFullYear() < year
      );
    });
    return bad.length ? `${bad.length} officer(s) appointed before their birth year` : null;
  },

  date_before_incorporation: (c, e) => {
    const inc = dateMs(e.incorporation_date);
    if (inc === null) return null;
    const check = (d: unknown) => {
      const ms = dateMs(d);
      return ms !== null && ms < inc - 366 * 86_400_000; // a year's grace for pre-incorporation paperwork
    };
    if (c.field === "charges" && asArray(c.value).some((x) => check(x.created_on))) {
      return "charge created more than a year before incorporation";
    }
    return null;
  },
};

export function checkClaims(
  claims: Claim[],
  entity: EntityContext,
  cfg: VerificationConfig["sanity"],
): SanityFailure[] {
  const failures: SanityFailure[] = [];
  for (const c of claims) {
    for (const [rule, fn] of Object.entries(RULES)) {
      const detail = fn(c, entity, cfg);
      if (detail) {
        failures.push({ claim_id: c.claim_id, rule, detail });
        break; // one recorded reason per claim is enough
      }
    }
  }
  return failures;
}

/** Build the entity context from a batch of claims (latest per field wins). */
export function contextFromClaims(claims: Claim[], base: EntityContext = {}): EntityContext {
  const ctx: EntityContext = { ...base };
  const latest = new Map<string, Claim>();
  for (const c of claims) {
    const prev = latest.get(c.field);
    if (!prev || toMillis(c.published_at) >= toMillis(prev.published_at)) latest.set(c.field, c);
  }
  const v = (f: string) => latest.get(f)?.value;
  if (latest.has("incorporation_date")) ctx.incorporation_date = v("incorporation_date") as string;
  if (latest.has("company_status")) ctx.company_status = v("company_status") as string;
  if (latest.has("dissolution_date")) ctx.dissolution_date = v("dissolution_date") as string;
  if (latest.has("employees_average")) ctx.employees_average = v("employees_average") as number;
  if (latest.has("turnover_gbp")) ctx.turnover_gbp = v("turnover_gbp") as number;
  return ctx;
}
