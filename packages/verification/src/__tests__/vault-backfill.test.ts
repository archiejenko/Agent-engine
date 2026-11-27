import { loadIndustriesConfig } from "@ae/config";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { backfillVault, industryOfSic, nationOfLad } from "../vault-backfill.ts";

const at = "2026-11-27T12:00:00.000Z";

async function world() {
  const s = await openSqliteStorage(":memory:");
  const run = await s.runs.start({ kind: "test" });
  await s.entities.upsertMany(
    [
      { id: "01234567", sic: ["43210"], lad: "E08000003" },
      { id: "sc123456", sic: ["62020"], lad: "S12000036" },
      { id: "NI000001", sic: [], lad: null },
    ].map((e) => ({
      entity_id: e.id,
      name: `CO ${e.id} LIMITED`,
      name_normalised: `co ${e.id}`,
      postcode: null,
      lad_code: e.lad,
      company_status: "active",
      accounts_category: null,
      sic_codes: e.sic,
      charges_count: null,
      incorporation_date: null,
    })),
    run.run_id,
  );
  await s.signals.putMany(
    [
      {
        signal_id: "website_outdated",
        signal_version: 1,
        entity_id: "01234567",
        as_of: at,
        value: 1,
        fact_ids: ["f1"],
      },
    ],
    run.run_id,
  );
  await s.scoutSignals.add({
    signal_id: "sc1",
    field: "job_postings",
    source_name: "company_website",
    source_url: "https://site.example/careers",
    lane: "open",
    entity_id: "01234567",
    signal_type: "hiring",
    value: "Electrician",
    taxonomy_node: "HR",
    market_key: "smes",
    market: { buyer: "SMEs", industry: null },
    observed_at: at,
  });
  return s;
}

describe("v4 vault backfill", () => {
  it("maps every entity to a business and a uk_ch external ID, with region and industry", async () => {
    const s = await world();
    const r = await backfillVault(s, { now: () => new Date(at) });
    expect(r.businesses).toBe(3);
    expect(r.external_ids).toBe(3);
    expect(await s.vault.businesses.unmappedEntities()).toEqual([]);
    expect(await s.vault.businesses.entitiesWithoutExternalId()).toEqual([]);
    const eng = await s.vault.businesses.get("gb-ch:01234567");
    expect(eng).toMatchObject({ market: "UK", region: "ENG", industry_code: "construction" });
    // Lower-case company numbers are normalised to upper case in the business ID.
    expect(await s.vault.businesses.get("gb-ch:SC123456")).toMatchObject({
      region: "SCO",
      industry_code: "digital",
    });
    expect(await s.vault.businesses.get("gb-ch:NI000001")).toMatchObject({
      region: null,
      industry_code: null,
    });
    expect(await s.vault.externalIds.resolve("uk_ch", "SC123456")).toBe("gb-ch:SC123456");
  });

  it("copies engine and scout signals into the one signals table (scouts untrusted)", async () => {
    const s = await world();
    const r = await backfillVault(s, { now: () => new Date(at) });
    expect(r.engine_signals_copied).toBe(1);
    expect(r.scout_signals_copied).toBe(1);
    expect(await s.vault.signals.uncopiedEngineSignals()).toBe(0);
    expect(await s.vault.signals.count("engine")).toBe(1);
    expect(await s.vault.signals.count("scout")).toBe(1);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const s = await world();
    await backfillVault(s, { now: () => new Date(at) });
    const again = await backfillVault(s, { now: () => new Date(at) });
    expect(again.engine_signals_copied).toBe(0);
    expect(again.businesses).toBe(3);
    expect(await s.vault.businesses.count()).toBe(3);
    expect(await s.vault.signals.count()).toBe(2);
  });

  it("helpers: nation from LAD code, industry from the first SIC division", () => {
    expect(nationOfLad("E08000001")).toBe("ENG");
    expect(nationOfLad("W06000015")).toBe("WAL");
    expect(nationOfLad("N09000003")).toBe("NIR");
    expect(nationOfLad(null)).toBeNull();
    const cfg = loadIndustriesConfig();
    expect(industryOfSic(["47110"], cfg)).toBe("retail");
    expect(industryOfSic([], cfg)).toBeNull();
  });
});
