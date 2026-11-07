import type { Claim } from "@ae/contracts";
import { Parser } from "htmlparser2";
import { canonicalJson, stableUuid } from "../../ids.ts";

/**
 * Companies House accounts data product: one iXBRL file per filed set of accounts.
 * We extract the average number of employees (the tag ends in AverageNumberEmployeesDuringPeriod in
 * the FRS 102 / FRS 105 taxonomies) for the most recent period in the document.
 * ASSUMPTIONS TO VERIFY: filename pattern Prod223_XXXX_<companynumber>_<yyyymmdd>.html and archive
 * names Accounts_Bulk_Data-YYYY-MM-DD.zip / Accounts_Monthly_Data-MonthYYYY.zip.
 */
export const ACCOUNTS_SOURCE = "companies_house_accounts";

export interface IxbrlResult {
  employees: number | null;
  periodEnd: string | null;
  companyNumber: string | null;
}

function parseIxNumber(text: string, attrs: Record<string, string>): number | null {
  if (attrs["xsi:nil"] === "true") return null;
  const fmt = (attrs.format ?? "").toLowerCase();
  const t = text.trim();
  if (/zerodash|fixed-zero|fixedzero/.test(fmt) || t === "-" || t === "–") return 0;
  const digits = /comma(decimal)?$|numcommadecimal/.test(fmt)
    ? t.replace(/\./g, "").replace(",", ".")
    : t.replace(/,/g, "");
  const n = Number(digits.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || digits.replace(/[^\d]/g, "") === "") return null;
  const scaled = n * 10 ** Number(attrs.scale ?? 0);
  return attrs.sign === "-" ? -scaled : scaled;
}

export function parseIxbrl(html: string): IxbrlResult {
  const contexts = new Map<string, string>(); // context id → period end / instant date
  const employeeFacts: { value: number; context: string }[] = [];
  let companyNumber: string | null = null;

  let currentContext: string | null = null;
  let capture: {
    kind: "date" | "employees" | "number";
    attrs: Record<string, string>;
    text: string;
  } | null = null;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const n = name.toLowerCase();
        if (n.endsWith(":context") && attrs.id) currentContext = attrs.id;
        else if (currentContext && (n.endsWith(":enddate") || n.endsWith(":instant"))) {
          capture = { kind: "date", attrs, text: "" };
        } else if (
          n === "ix:nonfraction" &&
          (attrs.name ?? "").endsWith("AverageNumberEmployeesDuringPeriod")
        ) {
          capture = { kind: "employees", attrs, text: "" };
        } else if (
          n === "ix:nonnumeric" &&
          (attrs.name ?? "").endsWith("UKCompaniesHouseRegisteredNumber")
        ) {
          capture = { kind: "number", attrs, text: "" };
        }
      },
      ontext(text) {
        if (capture) capture.text += text;
      },
      onclosetag(name) {
        const n = name.toLowerCase();
        const c = capture as typeof capture;
        if (
          c &&
          c.kind === "date" &&
          (n.endsWith(":enddate") || n.endsWith(":instant")) &&
          currentContext
        ) {
          const d = c.text.trim().slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) contexts.set(currentContext, d);
          capture = null;
        } else if (c && c.kind === "employees" && n === "ix:nonfraction") {
          const v = parseIxNumber(c.text, c.attrs);
          if (v !== null && c.attrs.contextref)
            employeeFacts.push({ value: v, context: c.attrs.contextref });
          capture = null;
        } else if (c && c.kind === "number" && n === "ix:nonnumeric") {
          companyNumber = c.text.trim().toUpperCase().replace(/\s+/g, "") || null;
          capture = null;
        }
        if (n.endsWith(":context")) currentContext = null;
      },
    },
    { xmlMode: false, lowerCaseAttributeNames: true, decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  // The latest period in the document is the current year; earlier ones are comparatives.
  let best: { value: number; end: string } | null = null;
  for (const f of employeeFacts) {
    const end = contexts.get(f.context) ?? "";
    if (!best || end > best.end) best = { value: f.value, end };
  }
  return { employees: best ? best.value : null, periodEnd: best?.end || null, companyNumber };
}

/** "Prod223_1234_01234567_20231231.html" → { companyNumber, madeUpDate } */
export function parseAccountsFileName(
  name: string,
): { companyNumber: string; madeUpDate: string } | null {
  const m = name.match(/_([A-Z0-9]{8})_(\d{4})(\d{2})(\d{2})\.(x?html?|xml)$/i);
  return m
    ? { companyNumber: (m[1] as string).toUpperCase(), madeUpDate: `${m[2]}-${m[3]}-${m[4]}` }
    : null;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Publication date of an archive: the daily file's date, or (conservatively) the last day of the
 * month for a monthly archive.
 */
export function accountsArchiveDate(zipName: string): string | null {
  const daily = zipName.match(/(\d{4}-\d{2}-\d{2})\.zip$/i);
  if (daily) return daily[1] as string;
  const monthly = zipName.match(/-([A-Za-z]+)(\d{4})\.zip$/);
  if (monthly) {
    const mi = MONTHS.indexOf((monthly[1] as string).toLowerCase());
    if (mi >= 0)
      return new Date(Date.UTC(Number(monthly[2]), mi + 1, 0)).toISOString().slice(0, 10);
  }
  return null;
}

export async function employeesClaim(
  o: {
    companyNumber: string;
    employees: number;
    periodEnd: string;
    published: string;
    fileRef: string;
  },
  runId: string,
  fetchedAt: string,
): Promise<Claim> {
  const published = `${o.published}T00:00:00Z`;
  return {
    claim_id: await stableUuid([
      ACCOUNTS_SOURCE,
      o.companyNumber,
      "employees_average",
      o.periodEnd,
      canonicalJson(o.employees),
    ]),
    entity_id: o.companyNumber,
    raw_entity_ref: { source_id: o.companyNumber, name: null },
    field: "employees_average",
    value: o.employees,
    source: ACCOUNTS_SOURCE,
    source_tier: 1,
    lane: "open",
    method: "bulk_file",
    evidence: { kind: "record", ref: o.fileRef },
    // The figure describes the period ending periodEnd; freshness is measured from then.
    observed_at: `${o.periodEnd}T00:00:00Z`,
    published_at: published,
    fetched_at: fetchedAt,
    run_id: runId,
  };
}
