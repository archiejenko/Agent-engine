import { loadGraphPolicy } from "@ae/config";
import { describe, expect, it } from "vitest";
import { assertStateSize } from "../graph-runtime.ts";

describe("graph state size", () => {
  const cap = loadGraphPolicy().runtime.state_value_max_bytes;

  it("the policy cap fits one D1 row (2,000,000 bytes) and one Workflow step result (1 MiB)", () => {
    expect(cap).toBeLessThanOrEqual(1_048_576);
    expect(cap).toBeLessThan(2_000_000);
  });

  it("accepts a value at the cap and refuses one over it", () => {
    const at = "x".repeat(cap - 2); // JSON adds the two quotes
    expect(() => assertStateSize({ draft: at }, cap)).not.toThrow();
    expect(() => assertStateSize({ draft: `${at}x` }, cap)).toThrow(/state value "draft"/);
  });

  it("counts bytes, not characters", () => {
    const pounds = "£".repeat(Math.ceil(cap / 2)); // two bytes each in UTF-8
    expect(() => assertStateSize({ note: pounds }, cap)).toThrow(/bytes/);
  });
});
