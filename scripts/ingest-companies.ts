import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCompaniesHouseConfig, loadUniverseConfig } from "@ae/config";
import { CompaniesHouseClient, defaultContext } from "@ae/verification";
import { diskCache, ingestCompanies } from "@ae/verification/node";
import { loadDevVars, log, openDb, ROOT } from "./lib.ts";

// Step 3 (needs CH_API_KEY): Companies House API for every universe member. Resumable: just run it
// again after an interruption. Responses are cached in data/cache/ch, so re-runs cost no API calls.
const { values } = parseArgs({ options: { limit: { type: "string" } } });
const apiKey = process.env.CH_API_KEY ?? loadDevVars().CH_API_KEY ?? "";
if (!apiKey) {
  console.error(
    "CH_API_KEY is missing. Add it to .dev.vars (see .dev.vars.example), then run this again.",
  );
  process.exit(1);
}
const config = loadCompaniesHouseConfig();
const storage = await openDb();
const client = new CompaniesHouseClient({
  apiKey,
  config,
  cache: diskCache(resolve(ROOT, "data/cache/ch")),
});
const r = await ingestCompanies(storage, defaultContext(), loadUniverseConfig(), client, {
  limit: values.limit ? Number(values.limit) : undefined,
  config,
  log,
});
log(
  `API run ${r.run_id}: ${JSON.stringify(r.progress)}; ${r.calls.toLocaleString()} API calls, ${r.cache_hits.toLocaleString()} from cache.`,
);
log("Next: pnpm gate:phase1");
await storage.close();
