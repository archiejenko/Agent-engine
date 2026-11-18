import { loadGraphPolicy } from "@ae/config";
import { describe, expect, it } from "vitest";
import { compile, RULES } from "../compiler.ts";
import { baseContext, baseSpec, fixtureLibrary, RULE_FIXTURES } from "../rule-fixtures.ts";

const policy = loadGraphPolicy();
const lib = fixtureLibrary(policy);

describe("compiler", () => {
  it("compiles the valid base graph", async () => {
    const r = await compile(baseSpec(), lib, policy, baseContext());
    expect(r.errors).toEqual([]);
    expect(r.compiled?.plan.order[0]).toBe("research");
    expect(r.compiled?.autonomy).toBe("L1");
    expect(r.compiled?.approvalPoints).toEqual(["approve"]);
  });

  for (const f of RULE_FIXTURES)
    it(`rule ${f.rule}: rejects ${f.name}`, async () => {
      const s = baseSpec();
      f.mutate(s);
      const r = await compile(s, lib, f.policy ? f.policy(policy) : policy, {
        ...baseContext(),
        ...(f.ctx ?? {}),
      });
      expect(r.ok).toBe(false);
      expect(r.errors.map((e) => e.rule)).toContain(f.rule);
      for (const e of r.errors) expect(e.message.length).toBeGreaterThan(0);
    });

  it("every rule but 'reproducible' (a property) has at least one failing fixture", () => {
    const covered = new Set(RULE_FIXTURES.map((f) => f.rule));
    for (const r of RULES) if (r !== "reproducible") expect(covered.has(r), r).toBe(true);
  });

  it("rule reproducible: the same spec and registry give the same hash; a new registry version changes it", async () => {
    const a = await compile(baseSpec(), lib, policy, baseContext());
    const b = await compile(baseSpec(), lib, policy, baseContext());
    const c = await compile(
      baseSpec(),
      { ...lib, registryVersion: "fixture-2" },
      policy,
      baseContext(),
    );
    expect(a.compiled?.contentHash).toBe(b.compiled?.contentHash);
    expect(c.compiled?.contentHash).not.toBe(a.compiled?.contentHash);
  });

  it("bespoke graphs are capped at L1 whatever is asked; the shape ignores per-task values", async () => {
    const s = baseSpec();
    const r = await compile(s, lib, policy, { taskLane: "open", perTaskCapGbp: 0.5 });
    expect(r.compiled?.autonomy).toBe("L1");
    const t = baseSpec();
    t.goal = "Draft for a different company entirely.";
    t.budgetGbp = 0.35;
    const r2 = await compile(t, lib, policy, baseContext());
    expect(r2.compiled?.shapeFingerprint).toBe(r.compiled?.shapeFingerprint);
  });
});
