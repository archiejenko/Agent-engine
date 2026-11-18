import { loadGraphPolicy } from "@ae/config";
import type { GraphSpec } from "@ae/contracts";
import { describe, expect, it } from "vitest";
import { checkProbe, sandboxCapReason } from "../probe.ts";
import { baseSpec, fixtureLibrary } from "../rule-fixtures.ts";

const policy = loadGraphPolicy();
const lib = fixtureLibrary(policy);

/** research → draft → check: read-only, no operator, three nodes. */
function probe(): GraphSpec {
  const s = baseSpec();
  s.nodes = s.nodes.filter((n) => ["research", "draft", "check"].includes(n.id));
  s.edges = s.edges.filter(
    (e) => ["research", "draft", "check"].includes(e.to) && e.from !== "approve",
  );
  s.exits = ["check"];
  return s;
}

describe("probes", () => {
  it("a small read-only graph may run as a probe", () => {
    expect(checkProbe(probe(), lib, policy)).toEqual([]);
  });

  it("refuses an operator, an approval, an external tool and too many nodes", () => {
    const full = baseSpec(); // has an approval and an operator that can send_email
    const rules = checkProbe(full, lib, policy).map((e) => e.message);
    expect(rules.some((m) => /at most 5 nodes/.test(m))).toBe(true);
    expect(rules.some((m) => /no operator/.test(m))).toBe(true);
    expect(rules.some((m) => /ask for approval/.test(m))).toBe(true);
    expect(rules.some((m) => /send_email, which acts externally/.test(m))).toBe(true);
    const tool = probe();
    tool.nodes.push({
      id: "mail",
      kind: "tool",
      ref: "send_email",
      reads: [],
      writes: [],
      budget: { maxCostGbp: 0, maxDurationS: 60 },
    });
    expect(checkProbe(tool, lib, policy).some((e) => e.nodeId === "mail")).toBe(true);
  });

  it("probe and sandbox spend share the per-graph cap", () => {
    const cap = policy.sandbox.max_cost_per_graph_gbp;
    expect(sandboxCapReason(cap - 1, 0.5, policy)).toBeNull();
    expect(sandboxCapReason(cap - 0.2, 0.5, policy)).toMatch(/sandbox cap/);
  });
});
