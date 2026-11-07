import { loadUniverseConfig } from "@ae/config";
import { defaultContext } from "@ae/verification";
import { ingestAccounts } from "@ae/verification/node";
import { log, openDb } from "./lib.ts";

// Step 2 (no API key needed): staff numbers from filed accounts, then the 5-100 staff rule.
// Usage: pnpm ingest:accounts data/sources/Accounts_Monthly_Data-*.zip
const zipFiles = process.argv.slice(2).filter((a) => a.endsWith(".zip"));
if (zipFiles.length === 0) {
  console.error("Usage: pnpm ingest:accounts <Accounts_Monthly_Data-*.zip ...>");
  process.exit(1);
}
const storage = await openDb();
const universe = loadUniverseConfig();
const r = await ingestAccounts(storage, defaultContext(), universe, { zipFiles, log });
log(
  `Accounts run ${r.run_id}: parsed ${r.parsed.toLocaleString()} files, ${r.with_employees.toLocaleString()} with an employee figure.`,
);
log(
  `Universe now: ${r.included.toLocaleString()} included (${r.staff_unknown.toLocaleString()} staff_unknown), ${r.excluded.toLocaleString()} excluded.`,
);
log("Next (needs CH_API_KEY in .dev.vars): pnpm ingest:companies --limit 10000");
await storage.close();
