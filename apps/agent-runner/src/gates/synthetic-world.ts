import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCompaniesHouseConfig, loadModelsConfig, loadUniverseConfig } from "@ae/config";
import { costGbp, type FakeModel, FakeWebFetcher, FakeWebsiteFinder } from "@ae/ports";
import type { Storage } from "@ae/storage";
import {
  CompaniesHouseClient,
  defaultContext,
  generateSites,
  ingestWebsites,
  TokenBucket,
} from "@ae/verification";
import {
  buildUniverse,
  generateSynthetic,
  ingestAccounts,
  ingestCompanies,
  syntheticChFetch,
} from "@ae/verification/node";

/** Builds a synthetic Phase 1 + websites world in `storage` (no network, no keys). */
export async function buildSyntheticWorld(
  storage: Storage,
  model: FakeModel,
  o: { count: number; seed?: number; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  const ctx = defaultContext();
  const universe = loadUniverseConfig();
  const set = await generateSynthetic(
    mkdtempSync(join(tmpdir(), "ae-world-")),
    o.count,
    o.seed ?? 2026,
  );
  await buildUniverse(storage, ctx, universe, { ...set });
  await ingestAccounts(storage, ctx, universe, { zipFiles: set.accountsFiles });
  const client = new CompaniesHouseClient({
    apiKey: "synthetic",
    config: loadCompaniesHouseConfig(),
    fetch: syntheticChFetch(set.companies),
    bucket: new TokenBucket(1_000_000, 1),
    sleep: async () => {},
  });
  await ingestCompanies(storage, ctx, universe, client, {});
  log(
    `phase 1 synthetic: ${(await storage.universe.counts(universe.name)).included} companies in the universe`,
  );

  const members = await storage.universe.list(universe.name, { included: true });
  const entities = [];
  for (const m of members) {
    const e = await storage.entities.get(m.entity_id);
    if (e) entities.push({ entity_id: e.entity_id, name: e.name, postcode: e.postcode });
  }
  const sites = generateSites(entities, o.seed ?? 2026);
  const models = loadModelsConfig();
  let extractionCost = 0;
  const w = await ingestWebsites(
    storage,
    ctx,
    universe,
    { finder: new FakeWebsiteFinder(sites.sites), fetcher: new FakeWebFetcher(sites.pages), model },
    {
      onModelUsage: async (_id, usage) => {
        const price = models.prices[usage.model] ?? models.prices["fake-model"];
        if (price) extractionCost += costGbp(usage, price, models.usd_to_gbp);
      },
    },
  );
  log(`websites: ${w.companies} companies, ${w.found} sites, ${w.quarantined} quarantined`);
  return { ctx, universe, websites: w, extraction_cost_gbp: extractionCost, set };
}
