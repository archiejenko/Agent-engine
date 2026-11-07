import type { Claim, VerifiedFact } from "@ae/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlDriver } from "../driver.ts";
import { migrate } from "../migrate.ts";
import { loadMigrations } from "../migrations-fs.ts";
import { SqlStorage } from "../sql-storage.ts";

export interface Harness {
  driver: SqlDriver;
  dispose(): Promise<void>;
}

/** The same behaviour is required of every adapter. Run this suite once per adapter. */
export function storageSuite(adapter: string, makeHarness: () => Promise<Harness>) {
  describe(`Storage contract on ${adapter}`, () => {
    let h: Harness;
    let s: SqlStorage;
    let runId: string;

    const claim = (overrides: Partial<Claim> = {}): Claim => ({
      claim_id: crypto.randomUUID(),
      entity_id: "01234567",
      raw_entity_ref: { source_id: "01234567", name: "ACME WIDGETS LTD" },
      field: "company_status",
      value: "active",
      source: "companies_house",
      source_tier: 1,
      lane: "open",
      method: "api",
      evidence: {
        kind: "record",
        ref: "https://api.company-information.service.gov.uk/company/01234567",
      },
      observed_at: "2026-10-01T00:00:00Z",
      published_at: "2026-10-02T00:00:00Z",
      fetched_at: "2026-11-07T09:00:00Z",
      run_id: runId,
      ...overrides,
    });

    const fact = (supporting: string[], overrides: Partial<VerifiedFact> = {}): VerifiedFact => ({
      entity_id: "01234567",
      field: "company_status",
      value: "active",
      confidence: 0.9,
      supporting_claims: supporting,
      conflicting_claims: [],
      lane: "open",
      valid_from: "2026-10-02T00:00:00Z",
      effective_from: "2026-10-01T00:00:00Z",
      last_verified_at: "2026-11-07T09:00:00Z",
      expires_at: null,
      status: "verified",
      ...overrides,
    });

    beforeEach(async () => {
      h = await makeHarness();
      const applied = await migrate(h.driver, loadMigrations());
      expect(applied).toContain("0001_core.sql");
      s = new SqlStorage(h.driver);
      runId = (await s.runs.start({ kind: "test", config_versions: { universe: "v1" } })).run_id;
    });

    afterEach(async () => {
      await h.dispose();
    });

    it("migrations apply from empty and re-running is a no-op", async () => {
      expect(await migrate(h.driver, loadMigrations())).toEqual([]);
      expect(await s.health()).toEqual({ ok: true, migrations: loadMigrations().length });
    });

    it("records runs with config versions", async () => {
      const run = await s.runs.get(runId);
      expect(run?.status).toBe("running");
      expect(run?.config_versions).toEqual({ universe: "v1" });
      await s.runs.finish(runId, "succeeded");
      expect((await s.runs.get(runId))?.status).toBe("succeeded");
    });

    it("round-trips claims exactly, including JSON values and evidence", async () => {
      const c = claim({ field: "sic_codes", value: ["62012", "62020"] });
      await s.claims.insertMany([c]);
      expect(await s.claims.get(c.claim_id)).toEqual(c);
      expect(await s.claims.listByRun(runId)).toEqual([c]);
    });

    it("validates claims against the contract before writing", async () => {
      const bad = claim({ method: "llm_extract", evidence: null });
      await expect(s.claims.insertMany([bad])).rejects.toThrow();
      expect(await s.claims.listByRun(runId)).toEqual([]);
    });

    it("insertMany is atomic: one bad row writes nothing", async () => {
      const good = claim();
      const dupe = { ...claim(), claim_id: good.claim_id };
      await expect(s.claims.insertMany([good, dupe])).rejects.toThrow();
      expect(await s.claims.listByRun(runId)).toEqual([]);
    });

    it("claims are append-only: the database refuses UPDATE and DELETE", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await expect(
        h.driver.run("UPDATE claims SET value = ? WHERE claim_id = ?", ['"dissolved"', c.claim_id]),
      ).rejects.toThrow(/append-only/);
      await expect(
        h.driver.run("DELETE FROM claims WHERE claim_id = ?", [c.claim_id]),
      ).rejects.toThrow(/append-only/);
      expect((await s.claims.get(c.claim_id))?.value).toBe("active");
    });

    it("supersedes claims without deleting them", async () => {
      const c = claim();
      await s.claims.insertMany([c]);
      await s.claims.supersede([c.claim_id], "rolled back", null);
      expect(await s.claims.isSuperseded(c.claim_id)).toBe(true);
      expect(await s.claims.get(c.claim_id)).toEqual(c);
    });

    it("keeps every version of a fact and serves the latest as current", async () => {
      const c1 = claim();
      const c2 = claim({ value: "liquidation", published_at: "2026-11-01T00:00:00Z" });
      await s.claims.insertMany([c1, c2]);

      const v1 = await s.facts.put(fact([c1.claim_id]), {
        run_id: runId,
        recorded_at: "2026-11-07T09:00:00Z",
      });
      const v2 = await s.facts.put(
        fact([c2.claim_id], { value: "liquidation", valid_from: "2026-11-01T00:00:00Z" }),
        { run_id: runId, recorded_at: "2026-11-07T10:00:00Z" },
      );
      expect([v1, v2]).toEqual([1, 2]);

      expect((await s.facts.getCurrent("01234567", "company_status"))?.value).toBe("liquidation");
      const versions = await s.facts.listVersions("01234567", "company_status");
      expect(versions.map((v) => [v.version, v.fact.value, v.recorded_at])).toEqual([
        [1, "active", "2026-11-07T09:00:00Z"],
        [2, "liquidation", "2026-11-07T10:00:00Z"],
      ]);
      expect(await s.facts.countCurrent()).toBe(1);
    });

    it("validates facts against the contract before writing", async () => {
      await expect(
        s.facts.put(fact([], {}), { run_id: runId, recorded_at: "2026-11-07T09:00:00Z" }),
      ).rejects.toThrow();
      expect(await s.facts.countCurrent()).toBe(0);
    });

    it("returns null for unknown rows", async () => {
      expect(await s.claims.get(crypto.randomUUID())).toBeNull();
      expect(await s.facts.getCurrent("99999999", "company_status")).toBeNull();
      expect(await s.runs.get(crypto.randomUUID())).toBeNull();
    });
  });
}
