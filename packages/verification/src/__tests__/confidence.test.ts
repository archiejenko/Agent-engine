import { describe, expect, it } from "vitest";
import { agree } from "../agreement.ts";
import { computeConfidence } from "../confidence.ts";
import { canonicalJson, stableUuid } from "../ids.ts";

const NOW = Date.parse("2026-11-07T00:00:00Z");
const c = (reliability: number, upstream: string, daysAgo = 0) => ({
  reliability,
  upstream,
  assertedAtMs: NOW - daysAgo * 86_400_000,
});
const base = { lambda: 1, halfLifeDays: 30, asOfMs: NOW };

describe("confidence model v1 (hand-computed examples)", () => {
  it("one tier-1 source, fresh: c = r = 0.95", () => {
    expect(
      computeConfidence({ ...base, supporting: [c(0.95, "ch")], conflicting: [] }),
    ).toBeCloseTo(0.95, 12);
  });

  it("two independent sources: 1 - (0.05 × 0.25) = 0.9875", () => {
    const v = computeConfidence({
      ...base,
      supporting: [c(0.95, "ch"), c(0.75, "web")],
      conflicting: [],
    });
    expect(v).toBeCloseTo(0.9875, 12);
  });

  it("two copies of the same upstream count once: 0.95, not 0.9975", () => {
    const v = computeConfidence({
      ...base,
      supporting: [c(0.95, "ch"), c(0.95, "ch")],
      conflicting: [],
    });
    expect(v).toBeCloseTo(0.95, 12);
  });

  it("conflict penalty: 0.95 × (1 - 0.75/1.70) = 0.5308823529", () => {
    const v = computeConfidence({
      ...base,
      supporting: [c(0.95, "ch")],
      conflicting: [c(0.75, "web")],
    });
    expect(v).toBeCloseTo(0.95 * (1 - 0.75 / 1.7), 12);
    expect(v).toBeCloseTo(0.5308823529, 9);
  });

  it("decay: one half-life old halves confidence; two half-lives quarters it", () => {
    expect(
      computeConfidence({ ...base, supporting: [c(0.95, "ch", 30)], conflicting: [] }),
    ).toBeCloseTo(0.475, 12);
    expect(
      computeConfidence({ ...base, supporting: [c(0.95, "ch", 60)], conflicting: [] }),
    ).toBeCloseTo(0.2375, 12);
  });

  it("age is measured from the NEWEST supporting assertion", () => {
    const v = computeConfidence({
      ...base,
      supporting: [c(0.95, "ch", 60), c(0.75, "web", 0)],
      conflicting: [],
    });
    expect(v).toBeCloseTo(0.9875, 12);
  });

  it("fields that never expire don't decay", () => {
    const v = computeConfidence({
      ...base,
      halfLifeDays: null,
      supporting: [c(0.95, "ch", 3650)],
      conflicting: [],
    });
    expect(v).toBeCloseTo(0.95, 12);
  });

  it("is always within 0-1 and 0 with no support", () => {
    expect(
      computeConfidence({
        ...base,
        lambda: 5,
        supporting: [c(0.5, "a")],
        conflicting: [c(0.95, "b")],
      }),
    ).toBe(0);
    expect(computeConfidence({ ...base, supporting: [], conflicting: [] })).toBe(0);
  });
});

describe("agreement within tolerance", () => {
  it("headcount ±10%", () => {
    const tol = { kind: "relative" as const, value: 0.1 };
    expect(agree(100, 110, tol)).toBe(true);
    expect(agree(100, 112, tol)).toBe(false);
    expect(agree(0, 0, tol)).toBe(true);
  });
  it("exact ignores object key order", () => {
    expect(agree({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }, { kind: "exact" })).toBe(true);
    expect(agree(["a", "b"], ["b", "a"], { kind: "exact" })).toBe(false);
  });
  it("absolute tolerance", () => {
    expect(agree(10, 12, { kind: "absolute", value: 2 })).toBe(true);
    expect(agree(10, 12.5, { kind: "absolute", value: 2 })).toBe(false);
  });
});

describe("ids", () => {
  it("stable uuids are deterministic, distinct and valid", async () => {
    const a = await stableUuid(["x", "1"]);
    expect(a).toBe(await stableUuid(["x", "1"]));
    expect(a).not.toBe(await stableUuid(["x", "2"]));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
