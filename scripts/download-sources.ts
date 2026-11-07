import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { log, ROOT } from "./lib.ts";

// Downloads the free Companies House files into data/sources (run on your laptop; several GB).
// ASSUMED URL PATTERNS (verify on download.companieshouse.gov.uk if a download 404s).
// The ONS postcode file must be downloaded by hand: see docs/runbooks/phase1-ingestion.md.
const dir = resolve(ROOT, "data/sources");
mkdirSync(dir, { recursive: true });
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const now = new Date();
const firstOfMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
const urls = [
  `https://download.companieshouse.gov.uk/BasicCompanyDataAsOneFile-${firstOfMonth}.zip`,
];
// Last 15 monthly accounts archives: covers everyone who files annually (plus late filers).
for (let i = 1; i <= 15; i++) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
  urls.push(
    `https://download.companieshouse.gov.uk/Accounts_Monthly_Data-${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear()}.zip`,
  );
}
for (const url of urls) {
  const file = resolve(dir, url.split("/").pop() as string);
  if (existsSync(file)) {
    log(`already have ${file}`);
    continue;
  }
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    log(
      `  skipped (HTTP ${res.status}) — check the file name on the Companies House download page`,
    );
    continue;
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
}
log(`Done. Files are in ${dir}`);
