import { loadSourcesConfig } from "@ae/config";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { type Fetcher, fetchKey, SourceRefused, SourceRegistry } from "../sources/registry.ts";

async function world(fetchers: Record<string, Fetcher> = {}) {
  const storage = await openSqliteStorage(":memory:");
  let t = new Date("2026-11-27T12:00:00.000Z");
  const reg = new SourceRegistry({
    storage,
    fetchers,
    now: () => t,
    synthetic: true,
  });
  await reg.sync();
  return {
    storage,
    reg,
    advance: (h: number) => {
      t = new Date(t.getTime() + h * 3_600_000);
    },
  };
}

const counting = (body: unknown, ids?: string[]) => {
  let calls = 0;
  const f: Fetcher = async () => {
    calls++;
    return { body, ids };
  };
  return { f, calls: () => calls };
};

describe("source registry (v4 Phase 1)", () => {
  it("registers every source in config; only sources in use before v4 start connected", async () => {
    const { storage } = await world();
    const all = await storage.vault.sources.list();
    expect(all.map((s) => s.source_id).sort()).toEqual(
      loadSourcesConfig()
        .sources.map((s) => s.source_id)
        .sort(),
    );
    const connected = all.filter((s) => s.connected).map((s) => s.source_id);
    expect(connected).toContain("companies_house");
    for (const lazy of [
      "the_gazette",
      "find_a_tender",
      "contracts_finder",
      "planning_data",
      "google_places_us",
    ])
      expect(connected).not.toContain(lazy);
  });

  it("refuses a source that isn't registered", async () => {
    const { reg } = await world({ made_up: async () => ({ body: {} }) });
    await expect(reg.fetch("made_up", { q: 1 })).rejects.toMatchObject({
      name: "SourceRefused",
      reason: "not_registered",
    });
    await expect(reg.connect("made_up", "opp_x")).rejects.toBeInstanceOf(SourceRefused);
  });

  it("refuses a registered source until it's connected lazily for an opportunity", async () => {
    const g = counting({ notices: [] });
    const { reg, storage } = await world({ the_gazette: g.f });
    await expect(reg.fetch("the_gazette", { q: "x" })).rejects.toMatchObject({
      reason: "not_connected",
    });
    expect(g.calls()).toBe(0);
    await reg.connect("the_gazette", "opp_uk_insolvency_watch");
    await reg.fetch("the_gazette", { q: "x" });
    const s = await storage.vault.sources.get("the_gazette");
    expect(s?.connected).toBe(true);
    expect(s?.used_by).toEqual(["opp_uk_insolvency_watch"]);
  });

  it("caches: the second identical fetch is served from the cache, until the freshness target passes", async () => {
    const ch = counting({ company_name: "SAMPLE LIMITED", company_status: "active" });
    const { reg, storage, advance } = await world({ companies_house: ch.f });
    const a = await reg.fetch("companies_house", { company_number: "01234567", view: "profile" });
    // Same request with keys in another order: same cache key.
    const b = await reg.fetch("companies_house", { view: "profile", company_number: "01234567" });
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.body).toEqual(a.body);
    expect(ch.calls()).toBe(1);
    expect((await storage.vault.fetches.stats("companies_house")).hits).toBe(1);
    advance(721); // companies_house freshness target is 720 h
    const c = await reg.fetch("companies_house", { company_number: "01234567", view: "profile" });
    expect(c.cached).toBe(false);
    expect(ch.calls()).toBe(2);
  });

  it("a large response (over the inline limit) is cached in the blob store and comes back intact", async () => {
    const big = { items: Array.from({ length: 400 }, (_, i) => ({ n: i, text: "x".repeat(40) })) };
    const ch = counting(big);
    const { reg } = await world({ companies_house: ch.f });
    await reg.fetch("companies_house", { q: "big" });
    const again = await reg.fetch("companies_house", { q: "big" });
    expect(again.cached).toBe(true);
    expect(again.body).toEqual(big);
    expect(ch.calls()).toBe(1);
  });

  it("id_only sources (Google Places): the place_id is kept, no body is ever stored, fields are re-fetched", async () => {
    const places = counting({ places: [{ id: "ChIJ_test", displayName: "Sample", rating: 4.5 }] }, [
      "ChIJ_test",
    ]);
    const { reg, storage } = await world({ google_places_us: places.f });
    await reg.connect("google_places_us", "opp_us_fl_test");
    const a = await reg.fetch("google_places_us", { text: "sample miami" });
    const b = await reg.fetch("google_places_us", { text: "sample miami" });
    expect(a.ids).toEqual(["ChIJ_test"]);
    expect(b.cached).toBe(false);
    expect(places.calls()).toBe(2);
    const row = await storage.vault.fetches.get(
      await fetchKey("google_places_us", { text: "sample miami" }),
    );
    expect(row?.body).toBeNull();
    expect(row?.ids).toEqual(["ChIJ_test"]);
  });

  it("a paid call writes a cost event at call time", async () => {
    const places = counting({ places: [] }, []);
    const { reg, storage } = await world({ google_places_us: places.f });
    const cfg = loadSourcesConfig();
    const priced = {
      ...cfg,
      sources: cfg.sources.map((s) =>
        s.source_id === "google_places_us"
          ? { ...s, cost_model: { kind: "per_call" as const, gbp: 0.02, assumed: true } }
          : s,
      ),
    };
    const r2 = new SourceRegistry({
      storage,
      fetchers: { google_places_us: places.f },
      config: priced,
      synthetic: true,
    });
    await r2.sync();
    await reg.connect("google_places_us", "opp_us_fl_test");
    const r = await r2.fetch(
      "google_places_us",
      { text: "x" },
      { opportunity_id: "opp_us_fl_test" },
    );
    expect(r.cost_gbp).toBe(0.02);
    const since = await storage.costEvents.spendSince("2000-01-01T00:00:00.000Z", {});
    expect(since).toBeCloseTo(0.02, 5);
  });

  it("a changed response shape marks the source schema_drift and stops fetches", async () => {
    let shape = 0;
    const f: Fetcher = async () => ({
      body: shape === 0 ? { company_name: "A" } : { companyName: "A" },
    });
    const { reg, storage, advance } = await world({ companies_house: f });
    await reg.fetch("companies_house", { company_number: "1" });
    shape = 1;
    advance(1);
    await expect(reg.fetch("companies_house", { company_number: "2" })).rejects.toMatchObject({
      reason: "schema_drift",
    });
    expect((await storage.vault.sources.get("companies_house"))?.health).toBe("schema_drift");
    await expect(reg.fetch("companies_house", { company_number: "1" })).rejects.toMatchObject({
      reason: "schema_drift",
    });
  });

  it("re-syncing config keeps runtime state (connected, used_by, schema hash)", async () => {
    const { reg, storage } = await world({ the_gazette: counting({ a: 1 }).f });
    await reg.connect("the_gazette", "opp_a");
    await reg.fetch("the_gazette", { q: 1 });
    await reg.sync();
    const s = await storage.vault.sources.get("the_gazette");
    expect(s?.connected).toBe(true);
    expect(s?.used_by).toEqual(["opp_a"]);
    expect(s?.schema_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
