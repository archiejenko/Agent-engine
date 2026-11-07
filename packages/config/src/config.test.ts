import { describe, expect, it } from "vitest";
import { isSicExcluded, loadConfidenceConfig, loadUniverseConfig } from "./index.ts";

describe("universe config", () => {
  const u = loadUniverseConfig();

  it("loads and validates", () => {
    expect(u.region.lad_codes).toHaveLength(10);
    expect(u.staff).toEqual({ min: 5, max: 100, unknown_policy: "include_flagged" });
    expect(u.location_basis).toBe("registered_office");
  });

  it("has a name for every borough code", () => {
    for (const code of u.region.lad_codes) expect(u.region.lad_names[code]).toBeTruthy();
  });

  it("excludes the agreed SIC codes and keeps estate/letting agents", () => {
    expect(u.sic_exclude.map((s) => s.code).sort()).toEqual(["64209", "68209", "74990", "99999"]);
    expect(isSicExcluded(["64209"], u)).toBe(true);
    expect(isSicExcluded(["99999"], u)).toBe(true);
    expect(isSicExcluded(["68310"], u)).toBe(false);
    expect(isSicExcluded(["68320"], u)).toBe(false);
  });

  it("keeps a trading company that also lists an excluded code", () => {
    expect(isSicExcluded(["64209", "62012"], u)).toBe(false);
  });

  it("refuses an invalid config instead of guessing", () => {
    expect(() => loadUniverseConfig({ ...u, staff: { min: 5 } })).toThrow();
    expect(() =>
      loadUniverseConfig({ ...u, sic_exclude: [{ code: "6420", reason: "x" }] }),
    ).toThrow();
  });
});

describe("confidence config", () => {
  it("has a prior for every tier, in trust order", () => {
    const c = loadConfidenceConfig();
    const p = c.tier_priors;
    expect(p["1"]).toBeGreaterThan(p["2"]);
    expect(p["2"]).toBeGreaterThan(p["3"]);
    expect(p["3"]).toBeGreaterThan(p["4"]);
    expect(p["4"]).toBeGreaterThan(p["5"]);
    expect(c.conflict_penalty_lambda).toBe(1);
  });
});
