import type { Claim } from "@ae/contracts";
import type { EntityRow } from "@ae/storage";
import { canonicalJson, stableUuid } from "../../ids.ts";
import { normaliseName, normalisePostcode } from "../../resolve.ts";

/**
 * Free Company Data Product (BasicCompanyData CSV). Header names are trimmed (the file has had
 * leading spaces in some headers). ASSUMPTION TO VERIFY: column names below and dd/mm/yyyy dates.
 */
export const BULK_SOURCE = "companies_house_bulk";
export const REQUIRED_BULK_COLUMNS = [
  "CompanyName",
  "CompanyNumber",
  "CompanyStatus",
  "RegAddress.PostCode",
];

export type BulkRow = Record<string, string>;

export function checkBulkHeader(headers: string[]): void {
  const have = new Set(headers.map((h) => h.trim()));
  const missing = REQUIRED_BULK_COLUMNS.filter((c) => !have.has(c));
  if (missing.length)
    throw new Error(`Bulk file format has changed: missing columns ${missing.join(", ")}`);
}

/** dd/mm/yyyy → yyyy-mm-dd (or null). */
export function bulkDate(v: string | undefined): string | null {
  const m = v?.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Map the bulk file's status words to the API's vocabulary, so the two copies agree. */
export function normaliseBulkStatus(v: string | undefined): string | null {
  const x = (v ?? "").trim().toLowerCase();
  if (!x) return null;
  if (x.startsWith("active")) return "active"; // includes "Active - Proposal to Strike off"
  const map: Record<string, string> = {
    dissolved: "dissolved",
    liquidation: "liquidation",
    "in administration": "administration",
    administration: "administration",
    "voluntary arrangement": "voluntary-arrangement",
    receivership: "receivership",
    "insolvency proceedings": "insolvency-proceedings",
    "converted/closed": "converted-closed",
  };
  return map[x] ?? x.replace(/[^a-z0-9]+/g, "-");
}

/** "MICRO ENTITY" → "micro-entity" (the API's last_accounts.type style). */
export function normaliseAccountCategory(v: string | undefined): string | null {
  const x = (v ?? "").trim().toLowerCase();
  return x ? x.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : null;
}

export function parseSic(row: BulkRow): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const m = row[`SICCode.SicText_${i}`]?.trim().match(/^(\d{5})\b/);
    if (m?.[1]) out.push(m[1]);
  }
  return [...new Set(out)].sort();
}

export function trimRow(raw: Record<string, string>): BulkRow {
  const out: BulkRow = {};
  for (const [k, v] of Object.entries(raw)) out[k.trim()] = (v ?? "").trim();
  return out;
}

export function bulkRowToEntity(
  row: BulkRow,
  ladByPostcode?: Map<string, string>,
): EntityRow | null {
  const num = row.CompanyNumber?.toUpperCase();
  const name = row.CompanyName;
  if (!num || !/^[A-Z0-9]{8}$/.test(num) || !name) return null;
  const postcode = normalisePostcode(row["RegAddress.PostCode"]);
  const charges = Number.parseInt(row["Mortgages.NumMortCharges"] ?? "", 10);
  return {
    entity_id: num,
    name,
    name_normalised: normaliseName(name),
    postcode,
    lad_code: postcode ? (ladByPostcode?.get(postcode) ?? null) : null,
    company_status: normaliseBulkStatus(row.CompanyStatus),
    accounts_category: normaliseAccountCategory(row["Accounts.AccountCategory"]),
    sic_codes: parseSic(row),
    charges_count: Number.isFinite(charges) ? charges : null,
    incorporation_date: bulkDate(row.IncorporationDate),
  };
}

/**
 * Claims from the bulk file for one company. The file is a snapshot dated `fileDate`, so everything
 * is published as of that date, except the incorporation date and company type, knowable since incorporation.
 */
export async function bulkEntityClaims(
  e: EntityRow,
  fileDate: string,
  fileName: string,
  runId: string,
  fetchedAt: string,
): Promise<Claim[]> {
  const pub = `${fileDate}T00:00:00Z`;
  const claims: Claim[] = [];
  const add = async (field: string, value: Claim["value"], published = pub) => {
    claims.push({
      claim_id: await stableUuid([
        BULK_SOURCE,
        e.entity_id,
        field,
        published,
        canonicalJson(value),
      ]),
      entity_id: e.entity_id,
      raw_entity_ref: { source_id: e.entity_id, name: e.name },
      field,
      value,
      source: BULK_SOURCE,
      source_tier: 1,
      lane: "open",
      method: "bulk_file",
      evidence: { kind: "record", ref: `${fileName}#${e.entity_id}` },
      observed_at: pub,
      published_at: published,
      fetched_at: fetchedAt,
      run_id: runId,
    });
  };
  await add("company_name", e.name);
  if (e.company_status) await add("company_status", e.company_status);
  if (e.incorporation_date)
    await add("incorporation_date", e.incorporation_date, `${e.incorporation_date}T00:00:00Z`);
  if (e.postcode) await add("registered_office_postcode", e.postcode);
  if (e.sic_codes.length) await add("sic_codes", e.sic_codes);
  if (e.accounts_category) await add("accounts_category", e.accounts_category);
  return claims;
}
