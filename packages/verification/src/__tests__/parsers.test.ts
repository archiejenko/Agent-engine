import { loadUniverseConfig } from "@ae/config";
import { describe, expect, it } from "vitest";
import {
  bulkDate,
  bulkRowToEntity,
  checkBulkHeader,
  normaliseAccountCategory,
  normaliseBulkStatus,
  parseSic,
  trimRow,
} from "../sources/companies-house/bulk.ts";
import {
  accountsArchiveDate,
  parseAccountsFileName,
  parseIxbrl,
} from "../sources/companies-house/ixbrl.ts";
import { addOnsRow, detectOnsColumns } from "../sources/ons/postcodes.ts";
import { decideCandidate, decideStaff } from "../universe.ts";

export const ixbrlDoc = (
  employees: string,
  attrs = "",
  prior = "4",
) => `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL">
<body>
<ix:header><ix:resources>
  <xbrli:context id="cy"><xbrli:entity/><xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period></xbrli:context>
  <xbrli:context id="py"><xbrli:entity/><xbrli:period><xbrli:startDate>2023-04-01</xbrli:startDate><xbrli:endDate>2024-03-31</xbrli:endDate></xbrli:period></xbrli:context>
</ix:resources></ix:header>
<p>Company number <ix:nonNumeric name="bus:UKCompaniesHouseRegisteredNumber" contextRef="cy">01234567</ix:nonNumeric></p>
<td><ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="py" unitRef="pure" decimals="0">${prior}</ix:nonFraction></td>
<td><ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="cy" unitRef="pure" decimals="0" ${attrs}>${employees}</ix:nonFraction></td>
</body></html>`;

describe("iXBRL accounts parser", () => {
  it("takes the current-year employee figure, not the comparative", () => {
    expect(parseIxbrl(ixbrlDoc("12"))).toEqual({
      employees: 12,
      periodEnd: "2025-03-31",
      companyNumber: "01234567",
    });
  });
  it("handles thousands separators, zero-dash and scale", () => {
    expect(parseIxbrl(ixbrlDoc("1,250")).employees).toBe(1250);
    expect(parseIxbrl(ixbrlDoc("-", 'format="ixt:zerodash"')).employees).toBe(0);
    expect(parseIxbrl(ixbrlDoc("1.2", 'scale="3"')).employees).toBe(1200);
  });
  it("returns null when no employee figure is filed", () => {
    expect(parseIxbrl("<html><body>nothing here</body></html>").employees).toBeNull();
  });
  it("reads file and archive names", () => {
    expect(parseAccountsFileName("Prod223_3456_01234567_20250331.html")).toEqual({
      companyNumber: "01234567",
      madeUpDate: "2025-03-31",
    });
    expect(parseAccountsFileName("readme.txt")).toBeNull();
    expect(accountsArchiveDate("Accounts_Bulk_Data-2026-11-06.zip")).toBe("2026-11-06");
    expect(accountsArchiveDate("Accounts_Monthly_Data-October2026.zip")).toBe("2026-10-31");
    expect(accountsArchiveDate("Accounts_Monthly_Data-February2028.zip")).toBe("2028-02-29");
  });
});

describe("bulk company file", () => {
  const row = trimRow({
    CompanyName: "ACME WIDGETS LTD",
    " CompanyNumber": "01234567",
    "RegAddress.PostCode": "m1 1aa",
    CompanyStatus: "Active - Proposal to Strike off",
    IncorporationDate: "02/03/2015",
    "Accounts.AccountCategory": "MICRO ENTITY",
    "Mortgages.NumMortCharges": "2",
    "SICCode.SicText_1": "62012 - Business and domestic software development",
    "SICCode.SicText_2": "None Supplied",
  });
  it("checks the header and normalises values to the API vocabulary", () => {
    expect(() =>
      checkBulkHeader([" CompanyNumber", "CompanyName", "CompanyStatus", "RegAddress.PostCode"]),
    ).not.toThrow();
    expect(() => checkBulkHeader(["CompanyName"])).toThrow(/format has changed/);
    expect(bulkDate("02/03/2015")).toBe("2015-03-02");
    expect(normaliseBulkStatus("Active - Proposal to Strike off")).toBe("active");
    expect(normaliseBulkStatus("In Administration")).toBe("administration");
    expect(normaliseAccountCategory("TOTAL EXEMPTION FULL")).toBe("total-exemption-full");
    expect(parseSic(row)).toEqual(["62012"]);
  });
  it("maps a row to an anchor entity with its borough", () => {
    const e = bulkRowToEntity(row, new Map([["M1 1AA", "E08000003"]]));
    expect(e).toMatchObject({
      entity_id: "01234567",
      postcode: "M1 1AA",
      lad_code: "E08000003",
      company_status: "active",
      accounts_category: "micro-entity",
      charges_count: 2,
      incorporation_date: "2015-03-02",
    });
  });
});

describe("ONS postcode lookup", () => {
  it("detects columns across releases and keeps only the region", () => {
    expect(detectOnsColumns(["pcd", "pcds", "lad23cd", "lad25cd"])).toEqual({
      postcode: "pcds",
      lad: "lad25cd",
    });
    expect(detectOnsColumns(["pcds", "oslaua"])).toEqual({ postcode: "pcds", lad: "oslaua" });
    expect(() => detectOnsColumns(["foo"])).toThrow();
    const m = new Map<string, string>();
    const cols = { postcode: "pcds", lad: "lad25cd" };
    addOnsRow(m, { pcds: "M1 1AA", lad25cd: "E08000003" }, cols, new Set(["E08000003"]));
    addOnsRow(m, { pcds: "CH1 1AA", lad25cd: "E06000050" }, cols, new Set(["E08000003"]));
    expect([...m]).toEqual([["M1 1AA", "E08000003"]]);
  });
});

describe("universe rules (from config)", () => {
  const u = loadUniverseConfig();
  const e = {
    entity_id: "01234567",
    name: "X",
    name_normalised: "X",
    postcode: "M1 1AA",
    lad_code: "E08000003",
    company_status: "active",
    accounts_category: "micro-entity",
    sic_codes: ["62012"],
    charges_count: 0,
    incorporation_date: "2015-01-01",
  };
  it("candidate rules", () => {
    expect(decideCandidate(e, u).reason).toBe("candidate");
    expect(decideCandidate({ ...e, lad_code: "E06000050" }, u).reason).toBe("outside_region");
    expect(decideCandidate({ ...e, company_status: "liquidation" }, u).reason).toBe(
      "status_liquidation",
    );
    expect(decideCandidate({ ...e, accounts_category: "dormant" }, u).reason).toBe("dormant");
    expect(decideCandidate({ ...e, sic_codes: ["64209"] }, u).reason).toBe("sic_excluded");
    expect(decideCandidate({ ...e, sic_codes: ["64209", "62012"] }, u).reason).toBe("candidate");
    expect(decideCandidate({ ...e, sic_codes: ["68310"] }, u).reason).toBe("candidate"); // estate agents kept
  });
  it("staff rule: 5-100, unknown kept and flagged", () => {
    expect(decideStaff(4, u)).toMatchObject({ included: false, staff_flag: "known" });
    expect(decideStaff(5, u)).toMatchObject({ included: true, staff_flag: "known" });
    expect(decideStaff(100, u)).toMatchObject({ included: true });
    expect(decideStaff(101, u)).toMatchObject({ included: false });
    expect(decideStaff(null, u)).toMatchObject({ included: true, staff_flag: "staff_unknown" });
  });
});
