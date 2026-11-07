import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCompaniesHouseConfig, loadUniverseConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultContext } from "../context.ts";
import { buildUniverse, ingestAccounts, ingestCompanies } from "../node/pipelines.ts";
import { generateSynthetic, type SyntheticSet, syntheticChFetch } from "../node/synthetic.ts";
import { getVerifiedFacts } from "../query.ts";
import { CompaniesHouseClient } from "../sources/companies-house/client.ts";

/** End-to-end on synthetic files with a known right answer: universe → accounts → API → facts. */
const universe = loadUniverseConfig();
const chCfg = loadCompaniesHouseConfig();
let storage: Storage;
let set: SyntheticSet;
const ctx = defaultContext();

beforeAll(async () => {
  set = await generateSynthetic(mkdtempSync(join(tmpdir(), "ae-synth-")), 300, 7);
  storage = await openSqliteStorage(":memory:");
}, 60_000);

describe("Phase 1 pipeline end to end (synthetic)", () => {
  it("step 1: builds the universe from the ONS lookup and bulk file", async () => {
    const r = await buildUniverse(storage, ctx, universe, {
      companiesFile: set.companiesFile,
      companiesFileDate: set.companiesFileDate,
      postcodesFile: set.postcodesFile,
      onsReleaseDate: set.onsReleaseDate,
    });
    expect(r.rows).toBe(300);
    expect(r.in_region).toBe(set.expected.in_region);
    expect(r.candidates).toBe(set.expected.candidates);
    expect(await storage.entities.count()).toBe(set.expected.in_region);
  });

  it("step 2: applies the 5-100 staff rule from filed accounts; unknown kept and flagged", async () => {
    const r = await ingestAccounts(storage, ctx, universe, { zipFiles: set.accountsFiles });
    expect(r.included).toBe(set.expected.included);
    expect(r.staff_unknown).toBe(set.expected.staff_unknown);
    for (const c of set.companies.filter((x) => x.candidate)) {
      const [m] = (await storage.universe.list(universe.name, {})).filter(
        (x) => x.entity_id === c.number,
      );
      expect(m?.included, c.number).toBe(c.expected !== "excluded");
    }
  }, 60_000);

  it("step 3: pulls the API for every universe member (resumable) and anchors 100%", async () => {
    const client = new CompaniesHouseClient({
      apiKey: "synthetic",
      config: chCfg,
      fetch: syntheticChFetch(set.companies),
      sleep: async () => {},
    });
    const r = await ingestCompanies(storage, ctx, universe, client, {});
    expect(r.progress).toEqual({ pending: 0, done: set.expected.included, failed: 0, skipped: 0 });
    // Running again does nothing: everything is already done.
    const again = await ingestCompanies(storage, ctx, universe, client, {});
    expect(again.calls).toBe(r.calls);

    const members = (await storage.universe.list(universe.name, { included: true })).map(
      (m) => m.entity_id,
    );
    const facts = await getVerifiedFacts(storage, ctx, {
      entities: members,
      fields: ["company_status", "officers_active", "registered_office_lad"],
      minConfidence: 0.5,
      asOf: "2026-11-07",
      lanes: ["open"],
      caller: "x402",
    });
    const anchored = new Set(facts.map((f) => f.entity_id));
    expect(anchored.size).toBe(members.length); // every member has verified facts
    expect(facts.every((f) => f.lane === "open" && f.status === "verified")).toBe(true);
  }, 120_000);

  it("point-in-time over real-shaped data: the September 2026 director isn't visible before the filing", async () => {
    const withNewcomer = set.companies.find(
      (c) => c.expected !== "excluded" && Number(c.number.slice(-4)) % 4 === 0,
    );
    expect(withNewcomer).toBeDefined();
    const at = async (asOf: string) =>
      (
        await getVerifiedFacts(storage, ctx, {
          entities: [withNewcomer?.number as string],
          fields: ["officers_active"],
          minConfidence: 0,
          asOf,
          lanes: ["open"],
          caller: "internal",
        })
      )[0]?.value as { name: string }[];
    expect((await at("2026-09-05")).length).toBe(1); // appointed 1 Sept, filed 12 Sept
    expect((await at("2026-09-12")).length).toBe(2);
  });
});
