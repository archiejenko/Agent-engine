import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim } from "@ae/contracts";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { defaultContext, ingestClaims, PointInTimeViolation, stableUuid } from "@ae/verification";
import { describe, expect, it } from "vitest";
import { assertNoLookAhead, backtest, moduleStatus, promoteModule } from "../backtest.ts";
import {
  acceptSuggestion,
  rejectSuggestion,
  suggestWeights,
  writeSuggestion,
} from "../calibrate.ts";
import { marginReport, moduleDigest } from "../digest.ts";
import { parseFramework } from "../framework.ts";
import { runModule } from "../runner.ts";

const NOTE = readFileSync(
  join(import.meta.dirname, "../../../../brain/frameworks/lead_gen_sme_web.md"),
  "utf8",
);
const AS_OF = "2026-09-30";

/** 200 companies; half had a director change before AS_OF. Planted truth: those reply far more often. */
async function world() {
  const storage = await openSqliteStorage(":memory:");
  const ctx = defaultContext();
  const run = (await storage.runs.start({ kind: "seed" })).run_id;
  const ids = Array.from({ length: 200 }, (_, i) => String(50_000_000 + i));
  await storage.universe.setMany([], run);
  await storage.entities.upsertMany(
    ids.map((id) => ({
      entity_id: id,
      name: id,
      name_normalised: id,
      postcode: null,
      lad_code: null,
      company_status: "active",
      accounts_category: null,
      sic_codes: [],
      charges_count: null,
      incorporation_date: null,
    })),
    run,
  );
  await storage.universe.setMany(
    ids.map((id) => ({
      universe: "lead_gen_sme_web_v1",
      entity_id: id,
      included: true,
      reason: "in_universe",
      staff_flag: "known",
    })),
    run,
  );
  const claims: Claim[] = [];
  for (const [i, id] of ids.entries()) {
    const changed = i % 5 === 0;
    const value = changed
      ? [{ appointed_on: "2026-09-01", resigned_on: null }]
      : [{ appointed_on: "2014-01-01", resigned_on: null }];
    const published = changed ? "2026-09-10T00:00:00Z" : "2014-01-15T00:00:00Z";
    claims.push({
      claim_id: await stableUuid(["companies_house", id, "officer_appointments", published]),
      entity_id: id,
      raw_entity_ref: { source_id: id, name: null },
      field: "officer_appointments",
      value,
      source: "companies_house",
      source_tier: 1,
      lane: "open",
      method: "api",
      evidence: { kind: "record", ref: "test" },
      observed_at: published,
      published_at: published,
      fetched_at: "2026-11-01T00:00:00Z",
      run_id: run,
    });
    // Knowable only AFTER the backtest date: must never influence it.
    claims.push({
      claim_id: await stableUuid(["company_website", id, "website_found"]),
      entity_id: id,
      raw_entity_ref: { source_id: id, name: null },
      field: "website_found",
      value: i % 3 === 0,
      source: "website_discovery",
      source_tier: 3,
      lane: "open",
      method: "scrape",
      evidence: { kind: "record", ref: "test" },
      observed_at: "2026-11-01T00:00:00Z",
      published_at: "2026-11-01T00:00:00Z",
      fetched_at: "2026-11-01T00:00:00Z",
      run_id: run,
    });
    const replies = changed ? true : i % 50 === 1; // all changed companies reply vs ~2% of the rest
    if (replies)
      await storage.outcomes.add({
        opportunity_id: null,
        entity_id: id,
        module: "lead_gen_sme_web",
        event: "positive_reply",
        value_bool: true,
        value_gbp: 1500,
        observed_at: "2026-10-15T00:00:00Z",
        source: "system",
      });
  }
  await ingestClaims(storage, ctx, { run_id: run, fetched_at: "2026-11-01T00:00:00Z" }, claims);
  return { storage, ctx, ids };
}

describe("backtester", async () => {
  const { storage, ctx } = await world();
  const fw = await parseFramework(NOTE);

  it("replays at a past date with only knowable facts and reports lift (mode stated)", async () => {
    const r = await backtest(storage, ctx, fw, { asOf: AS_OF });
    expect(r.mode).toBe("reconstructed");
    expect(r.candidates).toBe(200);
    expect(r.precision_at_20).toBeGreaterThan(0.3);
    expect(r.lift).toBeGreaterThan(3);
    expect(r.revenue_lift).toBeGreaterThan(3);
    expect(r.calibration).toHaveLength(5);
    expect((await storage.backtests.latest("lead_gen_sme_web"))?.lift).toBeCloseTo(r.lift, 12);
  });

  it("website facts published after the backtest date play no part (neutral)", async () => {
    const run = await runModule(storage, ctx, fw, { asOf: AS_OF, persist: false });
    for (const o of run.opportunities) {
      const w = o.trace.find((t) => t.signal_id === "website_age_years");
      expect(w?.raw_value).toBeNull();
    }
  });

  it("GUARDRAIL: a backtest fails if a fact from after as_of sneaks in", () => {
    const ok = [
      { trace: [{ fact_ids: ["50000000/officer_appointments/2026-09-10T00:00:00.000Z"] }] },
    ];
    expect(() => assertNoLookAhead(ok, AS_OF)).not.toThrow();
    const leak = [{ trace: [{ fact_ids: ["50000000/website_found/2026-11-01T00:00:00.000Z"] }] }];
    expect(() => assertNoLookAhead(leak, AS_OF)).toThrow(PointInTimeViolation);
  });

  it("a module goes live only with a backtest of this version at ≥ 3× lift", async () => {
    expect(await moduleStatus(storage, "lead_gen_sme_web")).toBe("pilot");
    await promoteModule(storage, fw, "test");
    expect(await moduleStatus(storage, "lead_gen_sme_web")).toBe("live");
    const other = await parseFramework(NOTE.replace("version: 1", "version: 2"));
    await expect(promoteModule(storage, other, "test")).rejects.toThrow(/different version/);
  });
});

describe("weight suggestions and digests", async () => {
  const { storage, ctx } = await world();
  const fw = await parseFramework(NOTE);
  // Leads proposed at AS_OF, all actioned; outcomes linked to their opportunities.
  const run = await runModule(
    storage,
    ctx,
    { ...fw, config: { ...fw.config, threshold: 0 } },
    { asOf: AS_OF },
  );
  for (const o of run.opportunities) {
    await storage.opportunities.setStatus(o.opportunity_id, "actioned");
    const hits = await storage.outcomes.forEntities(
      "positive_reply",
      "2026-09-30T00:00:00Z",
      "2026-11-01T00:00:00Z",
    );
    if (hits.some((h) => h.entity_id === o.entity_id)) {
      await storage.outcomes.add({
        opportunity_id: o.opportunity_id,
        entity_id: o.entity_id,
        module: "lead_gen_sme_web",
        event: "positive_reply",
        value_bool: true,
        value_gbp: 1500,
        observed_at: "2026-10-15T00:00:00Z",
        source: "human",
      });
    }
  }

  it("suggests revenue-weighted, blended weights once windows close; nothing changes until accepted", async () => {
    expect(await suggestWeights(storage, fw, new Date("2026-10-15T00:00:00Z"))).toBeNull(); // windows still open
    const maybe = await suggestWeights(storage, fw, new Date("2026-11-07T00:00:00Z"));
    expect(maybe).not.toBeNull();
    const s = maybe as NonNullable<typeof maybe>;
    const sum = Object.values(s.suggested).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 9);
    expect(s.suggested.director_change_90d).toBeGreaterThan(
      fw.config.signals.director_change_90d?.weight ?? 0,
    );
    const withBlock = await writeSuggestion(storage, NOTE, fw, s);
    expect(withBlock).toMatch(/Suggested weight change \(PENDING — not applied\)/);
    expect((await parseFramework(withBlock)).config.signals).toEqual(fw.config.signals); // unchanged until accepted
    const accepted = await acceptSuggestion(storage, withBlock, s.id);
    const after = await parseFramework(accepted);
    expect(after.config.version).toBe(2);
    expect(after.config.signals.director_change_90d?.weight).toBe(s.suggested.director_change_90d);
    expect(accepted).toMatch(/ACCEPTED/);
    await expect(rejectSuggestion(storage, accepted, s.id)).rejects.toThrow(/isn't pending/);
  });

  it("writes a weekly module digest and margin report", async () => {
    const d = await moduleDigest(storage, fw, new Date("2026-11-07T00:00:00Z"));
    expect(d.path).toBe("brain/digests/2026-11-07-lead_gen_sme_web.md");
    expect(d.markdown).toMatch(/Hit rate/);
    expect(d.markdown).toMatch(/positive_reply: \d+/);
    const m = await marginReport(storage, new Date("2026-11-07T00:00:00Z"));
    expect(m.markdown).toMatch(/Margin report/);
  });
});
