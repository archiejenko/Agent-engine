import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCompaniesHouseConfig, loadUniverseConfig } from "@ae/config";
import { CompaniesHouseClient, defaultContext, TokenBucket } from "@ae/verification";
import {
  buildUniverse,
  generateSynthetic,
  ingestAccounts,
  ingestCompanies,
  syntheticChFetch,
} from "@ae/verification/node";
import { log, openDb, ROOT } from "./lib.ts";

// Full-size rehearsal on SYNTHETIC data (no network, no key): proves the pipeline end to end at
// volume and measures processing speed. Writes to data/rehearsal.sqlite, never to your real DB.
const { values } = parseArgs({ options: { count: { type: "string", default: "13000" } } });
const count = Number(values.count);
const dir = resolve(ROOT, "data/synthetic");
const db = resolve(ROOT, "data/rehearsal.sqlite");
rmSync(db, { force: true });
rmSync(`${db}-wal`, { force: true });
rmSync(`${db}-shm`, { force: true });
mkdirSync(dir, { recursive: true });

const t0 = Date.now();
log(`Generating ${count.toLocaleString()} synthetic companies...`);
const set = await generateSynthetic(dir, count, 2026);
const storage = await openDb(db);
const ctx = defaultContext();
const universe = loadUniverseConfig();

const t1 = Date.now();
const u = await buildUniverse(storage, ctx, universe, { ...set, log });
log(
  `Universe: ${u.candidates.toLocaleString()} candidates (expected ${set.expected.candidates.toLocaleString()}) in ${((Date.now() - t1) / 1000).toFixed(1)}s`,
);
const t2 = Date.now();
const a = await ingestAccounts(storage, ctx, universe, { zipFiles: set.accountsFiles, log });
log(
  `Accounts: ${a.included.toLocaleString()} included (expected ${set.expected.included.toLocaleString()}) in ${((Date.now() - t2) / 1000).toFixed(1)}s`,
);

// No rate limit here (the fake API is local), so this measures OUR processing speed only.
const client = new CompaniesHouseClient({
  apiKey: "synthetic",
  config: loadCompaniesHouseConfig(),
  fetch: syntheticChFetch(set.companies),
  bucket: new TokenBucket(1_000_000, 1),
});
const t3 = Date.now();
const c = await ingestCompanies(storage, ctx, universe, client, { log });
const secs = (Date.now() - t3) / 1000;
log(
  `API step: ${c.progress.done.toLocaleString()} companies, ${c.calls.toLocaleString()} calls in ${secs.toFixed(0)}s (processing only)`,
);
const callsPerCompany = c.calls / Math.max(1, c.progress.done);
const realHours = (((callsPerCompany * 10_000) / (600 * 0.85)) * 5) / 60;
log(
  `Calls per company: ${callsPerCompany.toFixed(2)} → a real 10,000-company pull at 510 calls/5 min takes ≈ ${realHours.toFixed(1)} hours.`,
);
log(
  `Total ${((Date.now() - t0) / 1000).toFixed(0)}s. Now run: AE_DB=data/rehearsal.sqlite pnpm gate:phase1`,
);
await storage.close();
