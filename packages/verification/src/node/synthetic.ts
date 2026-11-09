import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yazl from "yazl";

/**
 * Synthetic Companies House + ONS data with a KNOWN right answer, for end-to-end tests and for
 * rehearsing a full-size run before the real API key is available. Nothing here is real data.
 * Seeded, so the same seed always produces the same files.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GM = [
  "E08000001",
  "E08000002",
  "E08000003",
  "E08000004",
  "E08000005",
  "E08000006",
  "E08000007",
  "E08000008",
  "E08000009",
  "E08000010",
];
const AREA: Record<string, string> = {
  E08000001: "BL",
  E08000002: "BL",
  E08000003: "M",
  E08000004: "OL",
  E08000005: "OL",
  E08000006: "M",
  E08000007: "SK",
  E08000008: "SK",
  E08000009: "M",
  E08000010: "WN",
};

export interface SyntheticCompany {
  number: string;
  name: string;
  postcode: string;
  lad: string;
  status: "Active" | "Liquidation" | "Dissolved";
  category: string;
  sic: string[];
  employees: number | null; // null = no accounts filed in the archive
  /** What's actually true (the golden oracle's answer); filed accounts are wrong for ~15%. */
  true_employees: number | null;
  /** Passes region, status, dormant and SIC rules (staff decided later). */
  candidate: boolean;
  expected: "in_universe" | "in_universe_staff_unknown" | "excluded";
}

export interface SyntheticSet {
  dir: string;
  companiesFile: string;
  companiesFileDate: string;
  postcodesFile: string;
  onsReleaseDate: string;
  accountsFiles: string[];
  companies: SyntheticCompany[];
  expected: { in_region: number; candidates: number; included: number; staff_unknown: number };
}

export async function generateSynthetic(
  dir: string,
  count: number,
  seed = 42,
): Promise<SyntheticSet> {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)] as T;
  await mkdir(dir, { recursive: true });
  const companies: SyntheticCompany[] = [];
  const onsRows: string[] = ["pcd,pcds,lad25cd"];

  for (let i = 0; i < count; i++) {
    const number = String(10_000_000 + i).padStart(8, "0");
    const inRegion = r() < 0.9;
    const lad = inRegion ? pick(GM) : "E06000050"; // Cheshire West and Chester
    const area = inRegion ? (AREA[lad] as string) : "CH";
    const postcode = `${area}${1 + (i % 9)} ${1 + (i % 9)}${"ABDEFGHJLNPQRSTUWXYZ"[i % 20]}${"ABDEFGHJLNPQRSTUWXYZ"[(i * 7) % 20]}`;
    onsRows.push(`${postcode.replace(" ", "")},${postcode},${lad}`);
    const roll = r();
    const status = roll < 0.92 ? "Active" : roll < 0.96 ? "Liquidation" : "Dissolved";
    const category =
      r() < 0.06
        ? "DORMANT"
        : pick(["MICRO ENTITY", "TOTAL EXEMPTION FULL", "SMALL", "UNAUDITED ABRIDGED"]);
    const sic =
      r() < 0.05
        ? ["64209"]
        : r() < 0.04
          ? ["68209"]
          : [pick(["62012", "43210", "56101", "68310", "70229", "47190", "86230"])];
    const trueEmployees = Math.floor(r() * 150) + 1;
    const filed = r() < 0.75;
    const noisy = r() < 0.15;
    const employees = filed
      ? noisy
        ? Math.max(1, Math.round(trueEmployees * (r() < 0.5 ? 0.6 : 1.4)))
        : trueEmployees
      : null;
    const candidate =
      inRegion &&
      status === "Active" &&
      category !== "DORMANT" &&
      !sic.every((s) => ["64209", "68209", "74990", "99999"].includes(s));
    const expected: SyntheticCompany["expected"] = !candidate
      ? "excluded"
      : employees === null
        ? "in_universe_staff_unknown"
        : employees >= 5 && employees <= 100
          ? "in_universe"
          : "excluded";
    companies.push({
      number,
      name: `SYNTHETIC TRADING ${i} LIMITED`,
      postcode,
      lad,
      status,
      category,
      sic,
      employees,
      true_employees: trueEmployees,
      candidate,
      expected,
    });
  }

  const onsReleaseDate = "2026-08-01";
  const postcodesFile = join(dir, "ONSPD_AUG_2026_UK.csv");
  await writeFile(postcodesFile, `${onsRows.join("\n")}\n`);

  // Bulk file (zip with one CSV), with the leading-space headers seen in the real file.
  const companiesFileDate = "2026-11-01";
  const companiesFile = join(dir, `BasicCompanyDataAsOneFile-${companiesFileDate}.zip`);
  const header = [
    "CompanyName",
    " CompanyNumber",
    "RegAddress.PostCode",
    "CompanyStatus",
    "IncorporationDate",
    "Accounts.AccountCategory",
    "Mortgages.NumMortCharges",
    "SICCode.SicText_1",
  ];
  const lines = [header.join(",")];
  for (const c of companies) {
    lines.push(
      [
        `"${c.name}"`,
        c.number,
        c.postcode,
        c.status,
        "02/03/2015",
        c.category,
        "1",
        `"${c.sic[0]} - Synthetic activity"`,
      ].join(","),
    );
  }
  await writeZip(companiesFile, [
    { name: `BasicCompanyDataAsOneFile-${companiesFileDate}.csv`, body: `${lines.join("\n")}\n` },
  ]);

  // Accounts archive: one iXBRL file per company that "filed" accounts.
  const accountsFile = join(dir, "Accounts_Monthly_Data-October2026.zip");
  await writeZip(
    accountsFile,
    companies
      .filter((c) => c.employees !== null)
      .map((c) => ({
        name: `Prod223_0001_${c.number}_20250331.html`,
        body: ixbrl(c.number, c.employees as number),
      })),
  );

  const candidates = companies.filter((c) => c.candidate);
  return {
    dir,
    companiesFile,
    companiesFileDate,
    postcodesFile,
    onsReleaseDate,
    accountsFiles: [accountsFile],
    companies,
    expected: {
      in_region: companies.filter((c) => c.lad !== "E06000050").length,
      candidates: candidates.length,
      included: companies.filter((c) => c.expected !== "excluded").length,
      staff_unknown: companies.filter((c) => c.expected === "in_universe_staff_unknown").length,
    },
  };
}

function ixbrl(number: string, employees: number) {
  return `<html><body><ix:header><ix:resources>
<xbrli:context id="cy"><xbrli:period><xbrli:startDate>2024-04-01</xbrli:startDate><xbrli:endDate>2025-03-31</xbrli:endDate></xbrli:period></xbrli:context>
</ix:resources></ix:header>
<ix:nonNumeric name="bus:UKCompaniesHouseRegisteredNumber" contextRef="cy">${number}</ix:nonNumeric>
<ix:nonFraction name="core:AverageNumberEmployeesDuringPeriod" contextRef="cy" unitRef="pure" decimals="0">${employees}</ix:nonFraction>
</body></html>`;
}

function writeZip(path: string, files: { name: string; body: string }[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const f of files) zip.addBuffer(Buffer.from(f.body), f.name);
    zip.end();
    zip.outputStream
      .pipe(createWriteStream(path))
      .on("close", () => resolve())
      .on("error", reject);
  });
}

/** Fake Companies House API serving plausible responses for synthetic companies. */
export function syntheticChFetch(companies: SyntheticCompany[]): typeof fetch {
  const byNumber = new Map(companies.map((c) => [c.number, c]));
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const m = url.pathname.match(/^\/company\/([A-Z0-9]{8})(\/[a-z-]+)?$/);
    const c = m ? byNumber.get(m[1] as string) : undefined;
    if (!m || !c) return new Response("{}", { status: 404 });
    const start = Number(url.searchParams.get("start_index") ?? 0);
    const page = (items: unknown[]) =>
      Response.json({
        items: items.slice(start, start + 100),
        total_results: items.length,
        total_count: items.length,
      });
    const seq = Number(c.number.slice(-4));
    switch (m[2]) {
      case undefined:
        return Response.json({
          company_name: c.name,
          company_number: c.number,
          company_status: c.status.toLowerCase(),
          type: "ltd",
          date_of_creation: "2015-03-02",
          // About 1 in 11 use their accountant's address as the registered office (a real pattern).
          registered_office_address:
            seq % 11 === 0
              ? {
                  care_of: "Ledger & Co Chartered Accountants",
                  address_line_1: "Ledger House, 10 Counting Street",
                  locality: "Manchester",
                  postal_code: c.postcode,
                  country: "England",
                }
              : {
                  address_line_1: `${seq} Synthetic Road`,
                  locality: "Manchester",
                  postal_code: c.postcode,
                  country: "England",
                },
          sic_codes: c.sic,
          accounts: {
            last_accounts: {
              made_up_to: "2025-03-31",
              type: c.category.toLowerCase().replace(/ /g, "-"),
            },
            next_due: "2026-12-31",
            overdue: seq % 17 === 0,
          },
          confirmation_statement: { next_due: "2027-03-16", overdue: false },
          has_insolvency_history: c.status !== "Active",
          has_been_liquidated: c.status === "Liquidation",
          has_charges: seq % 5 === 0,
          undeliverable_registered_office_address: false,
          registered_office_is_in_dispute: false,
        });
      case "/officers":
        return page([
          {
            name: `DIRECTOR, Synthetic ${seq}`,
            officer_role: "director",
            appointed_on: "2015-03-02",
            date_of_birth: { month: 1 + (seq % 12), year: 1960 + (seq % 30) },
          },
          ...(seq % 4 === 0
            ? [
                {
                  name: `NEWCOMER, Synthetic ${seq}`,
                  officer_role: "director",
                  appointed_on: "2026-09-01",
                },
              ]
            : []),
        ]);
      case "/filing-history":
        return page([
          {
            transaction_id: `a${seq}`,
            date: "2015-03-02",
            category: "incorporation",
            type: "NEWINC",
          },
          {
            transaction_id: `b${seq}`,
            date: "2025-11-20",
            category: "accounts",
            type: "AA",
            description_values: { made_up_date: "2025-03-31" },
          },
          {
            transaction_id: `c${seq}`,
            date: "2026-03-10",
            category: "confirmation-statement",
            type: "CS01",
          },
          ...(seq % 4 === 0
            ? [
                {
                  transaction_id: `d${seq}`,
                  date: "2026-09-12",
                  category: "officers",
                  type: "AP01",
                  action_date: "2026-09-01",
                },
              ]
            : []),
        ]);
      case "/charges":
        return page([
          {
            charge_code: `${c.number}0001`,
            created_on: "2024-05-01",
            delivered_on: "2024-05-03",
            status: "outstanding",
          },
        ]);
      case "/persons-with-significant-control":
        return page([
          {
            name: `Synthetic Owner ${seq}`,
            kind: "individual-person-with-significant-control",
            natures_of_control: ["ownership-of-shares-75-to-100-percent"],
            notified_on: "2016-04-06",
          },
        ]);
      default:
        return new Response("{}", { status: 404 });
    }
  }) as typeof fetch;
}
