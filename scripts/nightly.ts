import { resolve } from "node:path";
import { AgentService, loadPlaybooks } from "@ae/agent-runner";
import { loadCompaniesHouseConfig } from "@ae/config";
import {
  CompaniesHouseClient,
  defaultContext,
  nightlyReverify,
  runDriftCheck,
} from "@ae/verification";
import { diskCache } from "@ae/verification/node";
import { loadDevVars, log, openDb, ROOT } from "./lib.ts";

// Nightly job (Cron Trigger on Cloudflare at cutover): drift check → re-verification (only with a CH
// key) → task timeouts. Nothing external happens without keys.
const storage = await openDb();
const ctx = defaultContext();
const day = new Date().toISOString().slice(0, 10);
const drift = await runDriftCheck(storage, ctx, day);
log(`drift: ${drift.metrics.length} source/field pairs, ${drift.breaches.length} breaches`);
const key = process.env.CH_API_KEY ?? loadDevVars().CH_API_KEY;
if (key) {
  const config = loadCompaniesHouseConfig();
  const client = new CompaniesHouseClient({
    apiKey: key,
    config,
    cache: diskCache(resolve(ROOT, "data/cache/ch")),
  });
  log(`re-verification: ${JSON.stringify(await nightlyReverify(storage, ctx, client, config))}`);
} else log("re-verification skipped: no CH_API_KEY yet");
const service = new AgentService({
  storage,
  playbooks: await loadPlaybooks(resolve(ROOT, "playbooks")),
});
log(`runner: ${JSON.stringify(await service.tick())}`);
await storage.close();
