import type { VerifiedFact } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type VerificationContext } from "@ae/verification";

/**
 * "Check a UK business before you pay": the product behind the x402 endpoint (and, in Phase 5, the
 * human report). OPEN LANE ONLY — hard-wired: the caller is "x402"/"human_check", which the query layer
 * refuses to serve licensed facts to. Every field carries its confidence and last_verified_at.
 */
export const CHECK_FIELDS = [
  "company_name",
  "company_status",
  "company_type",
  "incorporation_date",
  "dissolution_date",
  "registered_office_address",
  "registered_office_flags",
  "sic_codes",
  "accounts_category",
  "last_accounts_made_up_to",
  "accounts_overdue",
  "confirmation_statement_overdue",
  "insolvency_flags",
  "officers_active",
  "psc_active",
  "charges",
  "website_url",
] as const;

export interface CheckField {
  value: unknown;
  confidence: number;
  status: VerifiedFact["status"];
  last_verified_at: string;
  known_since: string;
}

export interface CompanyCheck {
  company_number: string;
  as_of: string;
  tier: "cached" | "premium";
  live_check: "not_requested" | "refreshed";
  fields: Record<string, CheckField>;
  risk_flags: { flag: string; detail: string }[];
  disclaimer: string;
}

/** Deterministic risk flags from the facts (no model). */
export function riskFlags(f: Record<string, CheckField>): { flag: string; detail: string }[] {
  const out: { flag: string; detail: string }[] = [];
  const status = f.company_status?.value;
  if (typeof status === "string" && status !== "active")
    out.push({ flag: "not_active", detail: `Company status is ${status}` });
  if (f.accounts_overdue?.value === true)
    out.push({
      flag: "accounts_overdue",
      detail: "Annual accounts are overdue at Companies House",
    });
  if (f.confirmation_statement_overdue?.value === true)
    out.push({
      flag: "confirmation_statement_overdue",
      detail: "Confirmation statement is overdue",
    });
  const ins = f.insolvency_flags?.value as Record<string, boolean> | undefined;
  if (ins?.has_insolvency_history)
    out.push({ flag: "insolvency_history", detail: "The company has insolvency history" });
  if (ins?.has_been_liquidated)
    out.push({ flag: "liquidated", detail: "The company has been liquidated" });
  const ro = f.registered_office_flags?.value as Record<string, boolean> | undefined;
  if (ro?.undeliverable)
    out.push({
      flag: "office_undeliverable",
      detail: "Post to the registered office is undeliverable",
    });
  if (ro?.in_dispute)
    out.push({ flag: "office_in_dispute", detail: "The registered office address is in dispute" });
  const inc = f.incorporation_date?.value;
  if (typeof inc === "string" && Date.now() - Date.parse(inc) < 365 * 86_400_000)
    out.push({ flag: "young_company", detail: `Incorporated ${inc} (under a year ago)` });
  const charges = f.charges?.value;
  if (
    Array.isArray(charges) &&
    charges.some((c) => (c as { status?: string }).status === "outstanding")
  ) {
    out.push({
      flag: "outstanding_charges",
      detail: "Has outstanding secured borrowing (charges)",
    });
  }
  return out;
}

export async function companyCheck(
  storage: Storage,
  ctx: VerificationContext,
  companyNumber: string,
  o: { tier: "cached" | "premium"; caller: "x402" | "human_check"; refreshed?: boolean },
): Promise<CompanyCheck | null> {
  const asOf = new Date().toISOString();
  const facts = await getVerifiedFacts(storage, ctx, {
    entities: [companyNumber],
    fields: [...CHECK_FIELDS],
    minConfidence: 0,
    asOf,
    lanes: ["open"], // hard-wired: customer-facing products never read licensed data
    caller: o.caller,
  });
  if (facts.length === 0) return null;
  const fields: Record<string, CheckField> = {};
  for (const f of facts) {
    fields[f.field] = {
      value: f.value,
      confidence: Number(f.confidence.toFixed(3)),
      status: f.status,
      last_verified_at: f.last_verified_at,
      known_since: f.valid_from,
    };
  }
  return {
    company_number: companyNumber,
    as_of: asOf,
    tier: o.tier,
    live_check: o.refreshed ? "refreshed" : "not_requested",
    fields,
    risk_flags: riskFlags(fields),
    disclaimer:
      "Compiled from Companies House public data and the company's own website by EJTECH Ltd. Each field shows our confidence and when we last verified it. Not financial or legal advice.",
  };
}
