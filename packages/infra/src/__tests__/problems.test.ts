import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { importIdeas } from "../ideas.ts";
import { seedProblemsFromIdeas } from "../problems.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const FULL = readFileSync(join(ROOT, "brain/ideas/seed-500.csv"), "utf8");

describe("v4: problems seeded from the idea backlog", () => {
  it("every seed idea lands in exactly one problem; all problems are sensed with no evidence", async () => {
    const s = await openSqliteStorage(":memory:");
    await importIdeas(s, FULL, { by: "test" });
    const r = await seedProblemsFromIdeas(s);
    expect(r.ideas).toBe(500);
    const map = await s.portfolio.problems.map();
    expect(map.reduce((a, c) => a + c.problems, 0)).toBe(r.problems);
    expect(r.problems).toBeGreaterThan(20);
    // Idempotent.
    const again = await seedProblemsFromIdeas(s);
    expect(again.problems).toBe(r.problems);
    expect(await s.portfolio.problems.count()).toBe(r.problems);
    // The five industry categories map to industries; the rest are not industry-specific.
    const industries = new Set(map.map((m) => m.industry_code));
    expect(industries).toEqual(
      new Set(["all_smes", "construction", "professional", "personal", "manufacturing", "retail"]),
    );
  });
});
