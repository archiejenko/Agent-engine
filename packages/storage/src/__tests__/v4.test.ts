import { describe, expect, it } from "vitest";
import { migrate, rollback } from "../migrate.ts";
import {
  loadDownMigrations,
  loadMigrations,
  migrationsDirFor,
  migrationsDownDirFor,
} from "../migrations-fs.ts";
import { openSqliteStorage, sqliteDriver } from "../sqlite.ts";

const at = "2026-11-27T12:00:00.000Z";

describe("v4 Phase 1: lead_scores rename (0031)", () => {
  it("keeps every lead row, and reverses cleanly", async () => {
    const core = loadMigrations(migrationsDirFor("core"));
    const db = sqliteDriver(":memory:");
    await migrate(
      db,
      core.filter((m) => m.name < "0031"),
    );
    const cols = (
      await db.all<{ name: string }>("SELECT name FROM pragma_table_info('opportunities')")
    ).map((c) => c.name);
    const row = Object.fromEntries(
      cols.map((c) => [c, c === "explore" || c === "score" || c.endsWith("_gbp") ? 0 : `v-${c}`]),
    );
    row.module_version = 1;
    row.confidence = 0.5;
    row.rank = 1;
    row.lane = "open";
    row.status = "proposed";
    row.run_id = "r1";
    await db.run(
      `INSERT INTO opportunities (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((c) => row[c] as string | number),
    );
    const n31 = core.find((m) => m.name.startsWith("0031")) as (typeof core)[number];
    await migrate(
      db,
      core.filter((m) => m.name <= n31.name),
    );
    expect(await db.all("SELECT opportunity_id FROM lead_scores")).toEqual([
      { opportunity_id: "v-opportunity_id" },
    ]);
    const idx = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lead_scores' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["lead_scores_entity", "lead_scores_queue"]));
    await rollback(
      db,
      n31,
      loadDownMigrations(migrationsDownDirFor("core")).get(n31.name) as string,
    );
    expect(await db.all("SELECT opportunity_id FROM opportunities")).toEqual([
      { opportunity_id: "v-opportunity_id" },
    ]);
  });
});

describe("v4 Phase 1 storage", () => {
  it("businesses + external IDs: the UK mapping is 1:1 with entities", async () => {
    const s = await openSqliteStorage(":memory:");
    const run = await s.runs.start({ kind: "test" });
    await s.entities.upsertMany(
      ["01234567", "SC123456"].map((id) => ({
        entity_id: id,
        name: `CO ${id} LIMITED`,
        name_normalised: `co ${id}`,
        postcode: "M1 1AA",
        lad_code: "E08000003",
        company_status: "active",
        accounts_category: null,
        sic_codes: [],
        charges_count: null,
        incorporation_date: null,
      })),
      run.run_id,
    );
    expect(await s.vault.businesses.unmappedEntities()).toEqual(["01234567", "SC123456"]);
    await s.vault.businesses.putMany([
      {
        business_id: "gb-ch:01234567",
        name: "CO 01234567 LIMITED",
        name_normalised: "co 01234567",
        market: "UK",
        region: "ENG",
        status: "active",
        company_type: null,
        industry_code: null,
        size_band: null,
        primary_domain: null,
        merged_into: null,
        source_run_id: run.run_id,
      },
    ]);
    await s.vault.externalIds.putMany([
      {
        business_id: "gb-ch:01234567",
        scheme: "uk_ch",
        value: "01234567",
        source_id: "companies_house_api",
        confidence: 1,
        fetched_at: at,
      },
    ]);
    expect(await s.vault.businesses.unmappedEntities()).toEqual(["SC123456"]);
    expect(await s.vault.businesses.entitiesWithoutExternalId()).toEqual(["SC123456"]);
    expect(await s.vault.externalIds.resolve("uk_ch", "01234567")).toBe("gb-ch:01234567");
    expect(await s.vault.businesses.count("UK")).toBe(1);
  });

  it("the audit log is append-only: no update or delete in the API", async () => {
    const s = await openSqliteStorage(":memory:");
    expect(Object.keys(s.auditLog).sort()).toEqual(["append", "count"]);
    await s.auditLog.append({
      audit_id: "a1",
      at,
      actor: "system",
      action: "test",
      opportunity_id: null,
      touch_id: null,
      recipient_hash: null,
      basis: null,
      source_ids: [],
      fact_ids: [],
      compliance_pack: null,
      guardrail_hash: null,
      effect_key: null,
      market: "UK",
      dry_run: true,
      synthetic: true,
    });
    expect(await s.auditLog.count()).toBe(1);
  });

  it("the old lead-score API still works on the renamed table", async () => {
    const s = await openSqliteStorage(":memory:");
    expect(await s.opportunities.list({ limit: 5 })).toEqual([]);
  });
});
