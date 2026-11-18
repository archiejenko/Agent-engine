import { loadGraphPolicy, loadModelsConfig } from "@ae/config";
import { describe, expect, it } from "vitest";
import { priceModelCall, rollUp } from "../costs.ts";
import { canonicalJson, exportNodeLibrary } from "../registry-export.ts";

const models = loadModelsConfig();

describe("pricing model calls from reported usage", () => {
  it("Opus 5.5: matches a hand calculation ($4 in, $20 out, $0.20 cache read per MTok)", () => {
    const r = priceModelCall(
      "claude-opus-5-5",
      { input_tokens: 6000, output_tokens: 1500, cache_read_input_tokens: 10000 },
      models,
    );
    const usd = (6000 * 4 + 1500 * 20 + 10000 * 0.2) / 1_000_000;
    expect(r.total_gbp).toBeCloseTo(usd * models.usd_to_gbp, 12);
    expect(r.lines.map((l) => l.unit)).toEqual([
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
    ]);
  });

  it("cache writes: 1.25x input for 5 minutes, 2x for 1 hour", () => {
    const five = priceModelCall(
      "claude-opus-5-5",
      { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
      models,
    );
    const hour = priceModelCall(
      "claude-opus-5-5",
      {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_ttl: "1h",
      },
      models,
    );
    expect(five.total_gbp).toBeCloseTo(5 * models.usd_to_gbp, 10);
    expect(hour.total_gbp).toBeCloseTo(8 * models.usd_to_gbp, 10);
  });

  it("Haiku 5.5 long-context tier applies over 100,000 input tokens, cache included", () => {
    const short = priceModelCall(
      "claude-haiku-5-5",
      { input_tokens: 100_000, output_tokens: 1000 },
      models,
    );
    const long = priceModelCall(
      "claude-haiku-5-5",
      { input_tokens: 90_000, output_tokens: 1000, cache_read_input_tokens: 20_000 },
      models,
    );
    expect(short.total_gbp).toBeCloseTo(
      ((100_000 * 0.1 + 1000 * 0.5) / 1e6) * models.usd_to_gbp,
      12,
    );
    expect(long.total_gbp).toBeCloseTo(
      ((90_000 * 0.5 + 1000 * 2.5 + 20_000 * 0.05) / 1e6) * models.usd_to_gbp,
      12,
    );
  });

  it("an unknown model is refused rather than guessed", () => {
    expect(() =>
      priceModelCall("claude-imaginary", { input_tokens: 1, output_tokens: 1 }, models),
    ).toThrow(/no price/);
  });

  it("the price table carries a version and the date it was checked", () => {
    expect(models.price_table_version).toBe("2026-11-18");
    expect(models.prices_checked_at).toBe("2026-11-18");
  });

  it("roll-ups are sums of their events", () => {
    const ev = [
      { k: "a", amount_gbp: 0.1 },
      { k: "a", amount_gbp: 0.2 },
      { k: "b", amount_gbp: 0.05 },
    ];
    const r = rollUp(ev, (e) => e.k);
    expect(r.get("a")?.gbp).toBeCloseTo(0.3, 12);
    expect(r.get("a")?.n).toBe(2);
  });
});

describe("node library export", () => {
  const tool = (name: string, external = false) => ({
    name,
    description: name,
    allowed_lanes: ["open" as const],
    external,
    serves_customer: false,
    allowed_roles: [external ? ("operator" as const) : ("researcher" as const)],
    rate_limit_per_min: 10,
    cost_gbp_per_call: 0,
  });
  it("is deterministic: same inputs, same registry version, whatever the input order", async () => {
    const policy = loadGraphPolicy();
    const a = await exportNodeLibrary({
      tools: [tool("b"), tool("a", true)],
      models,
      playbooks: [],
      policy,
    });
    const b = await exportNodeLibrary({
      tools: [tool("a", true), tool("b")],
      models,
      playbooks: [],
      policy,
    });
    expect(a.registryVersion).toBe(b.registryVersion);
    expect(a.tools.find((t) => t.ref === "a")?.acts_externally).toBe(true);
    const c = await exportNodeLibrary({ tools: [tool("a", true)], models, playbooks: [], policy });
    expect(c.registryVersion).not.toBe(a.registryVersion);
  });
  it("canonical JSON sorts keys", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
  });
});
