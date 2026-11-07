import { basename } from "node:path";
import { parseArgs } from "node:util";
import { loadUniverseConfig } from "@ae/config";
import { defaultContext } from "@ae/verification";
import { buildUniverse } from "@ae/verification/node";
import { dateFromName, log, openDb } from "./lib.ts";

// Step 1 (no API key needed): build the Greater Manchester universe from the bulk file + ONS lookup.
// Usage: pnpm ingest:universe --companies data/sources/BasicCompanyDataAsOneFile-2026-11-01.zip \
//          --postcodes data/sources/ONSPD_AUG_2026_UK.csv --ons-date 2026-08-01
const { values } = parseArgs({
  options: {
    companies: { type: "string" },
    "companies-date": { type: "string" },
    postcodes: { type: "string" },
    "ons-date": { type: "string" },
  },
});
if (!values.companies || !values.postcodes) {
  console.error(
    "Usage: pnpm ingest:universe --companies <BasicCompanyData zip/csv> --postcodes <ONS csv/zip> [--companies-date YYYY-MM-DD] [--ons-date YYYY-MM-DD]",
  );
  process.exit(1);
}
const companiesFileDate = values["companies-date"] ?? dateFromName(basename(values.companies));
const onsReleaseDate = values["ons-date"];
if (!companiesFileDate || !onsReleaseDate) {
  console.error(
    "Need --companies-date (if the file name has no date) and --ons-date (the ONS release date).",
  );
  process.exit(1);
}
const storage = await openDb();
const universe = loadUniverseConfig();
const r = await buildUniverse(storage, defaultContext(), universe, {
  companiesFile: values.companies,
  companiesFileDate,
  postcodesFile: values.postcodes,
  onsReleaseDate,
  log,
});
log(
  `Universe run ${r.run_id}: ${r.in_region.toLocaleString()} companies in ${universe.region.name}, ${r.candidates.toLocaleString()} candidates.`,
);
console.table(r.reasons);
log("Next: pnpm ingest:accounts <accounts zip files...>");
await storage.close();
