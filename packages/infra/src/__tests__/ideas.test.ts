import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadIdeaCategoriesConfig } from "@ae/config";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import {
  applyIdeaDecision,
  changeIdeaScore,
  IdeaImportError,
  ideaMatrix,
  ideaReraiseBlocked,
  ideaScore,
  importIdeas,
  setIdeaStage,
  validateIdeasSheet,
} from "../ideas.ts";

const ROOT = join(import.meta.dirname, "../../../..");
const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures/seed-ideas-10.csv"), "utf8");
const FULL = readFileSync(join(ROOT, "brain/ideas/seed-500.csv"), "utf8");
const lines = (t: string) => t.split(/\r?\n/).filter(Boolean);
/** Replace one cell of one data row (1-based) — the fixture has no quoted cells before `matrix`. */
const editCell = (t: string, row: number, col: number, v: string) => {
  const ls = lines(t);
  const cells = (ls[row] as string).split(",");
  cells[col] = v;
  ls[row] = cells.join(",");
  return `${ls.join("\r\n")}\r\n`;
};
const COL = (name: string) => (lines(FIXTURE)[0] as string).split(",").indexOf(name);

describe("seeded ideas: score and matrix are recomputed in code", () => {
  it("formula: weighted mean of the six scores as a share of 5; matrix from value and feasibility", () => {
    const top = {
      autonomy: 5,
      speed_to_cash: 4,
      demand: 5,
      margin: 4,
      ease_of_build: 4,
      low_risk: 5,
    };
    expect(ideaScore(top)).toBe(91);
    expect(ideaMatrix(top)).toBe("Do first");
    expect(
      ideaScore({
        autonomy: 1,
        speed_to_cash: 1,
        demand: 1,
        margin: 1,
        ease_of_build: 1,
        low_risk: 1,
      }),
    ).toBe(20);
    expect(ideaMatrix({ ...top, demand: 3, margin: 4 })).toBe("Quick win");
    expect(ideaMatrix({ ...top, autonomy: 2 })).toBe("Big bet");
    expect(ideaMatrix({ ...top, autonomy: 2, demand: 3 })).toBe("Park");
  });
  it("recomputed score and matrix match the file for all 500 rows", () => {
    const r = validateIdeasSheet(FULL);
    expect(r.file_problems).toEqual([]);
    expect(r.rejected).toEqual([]);
    expect(r.rows).toHaveLength(500);
    expect(r.mismatches).toEqual([]);
    expect(new Set(r.rows.map((x) => x.id)).size).toBe(500);
    expect(r.rows.every((x) => x.score_source === "estimate")).toBe(true);
  });
});

describe("seeded ideas: import", () => {
  it("rejects the whole file and names the rows: score 6, unknown matrix, duplicate id", async () => {
    const storage = await openSqliteStorage(":memory:");
    const bad = editCell(editCell(FIXTURE, 3, COL("autonomy"), "6"), 5, COL("matrix"), "Maybe");
    const dup = editCell(bad, 7, COL("id"), (lines(FIXTURE)[1] as string).split(",")[0] as string);
    const err = await importIdeas(storage, dup, { by: "test" }).catch((e) => e);
    expect(err).toBeInstanceOf(IdeaImportError);
    const rows = (err as IdeaImportError).report.rejected.map((r) => r.row);
    expect(rows).toEqual([3, 5, 7]);
    expect((err as IdeaImportError).message).toMatch(/row 3 .*autonomy "6" is outside 1–5/);
    expect(await storage.hypotheses.count()).toBe(0);
  });

  it("imports, then a re-import keeps Archie's decision, comments and a changed stage, but updates text and scores with history", async () => {
    const storage = await openSqliteStorage(":memory:");
    const first = await importIdeas(storage, FIXTURE, { by: "archie" });
    expect(first).toMatchObject({ rows: 10, created: 10, updated: 0 });
    const ids = (await storage.hypotheses.list()).map((h) => h.id);
    const [a, b, c] = ids as [string, string, string];
    await applyIdeaDecision(storage, a, "Fail", "archie", "Not for us");
    await setIdeaStage(storage, b, "testing", "agent:researcher");
    const again = await importIdeas(storage, FIXTURE, { by: "archie" });
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 10 });
    // The sheet changes c's text and one score; still nothing of Archie's is touched.
    const rowOf = (id: string) => lines(FIXTURE).findIndex((l) => l.startsWith(`${id},`));
    let edited = editCell(FIXTURE, rowOf(a), COL("decision"), "Pass");
    edited = editCell(edited, rowOf(b), COL("status"), "Built");
    edited = editCell(edited, rowOf(c), COL("buyer"), "Accountants");
    edited = editCell(edited, rowOf(c), COL("demand"), "2");
    const third = await importIdeas(storage, edited, { by: "archie" });
    expect(third.updated).toBe(2);
    const ha = await storage.hypotheses.get(a);
    expect(ha).toMatchObject({ decision: "Fail", decision_by: "archie", comments: "Not for us" });
    expect((await storage.hypotheses.get(b))?.stage).toBe("testing");
    const hc = await storage.hypotheses.get(c);
    expect(hc).toMatchObject({ buyer: "Accountants", demand: 2, score_source: "estimate" });
    const hist = await storage.hypotheses.history(c);
    expect(hist.at(-1)).toMatchObject({ field: "demand", new_value: 2, changed_by: "import" });
  });

  it("score changes record the new value, who, when and why; score and matrix follow", async () => {
    const storage = await openSqliteStorage(":memory:");
    await importIdeas(storage, FIXTURE, { by: "archie" });
    const id = (await storage.hypotheses.list())[0]?.id as string;
    await expect(
      changeIdeaScore(storage, id, "demand", 6, { by: "archie", reason: "x" }),
    ).rejects.toThrow(/1_5/);
    await expect(
      changeIdeaScore(storage, id, "demand", 2, { by: "archie", reason: " " }),
    ).rejects.toThrow(/reason/);
    const h = await changeIdeaScore(storage, id, "demand", 2, {
      by: "agent:researcher",
      reason: "few buyers found",
    });
    expect(h.score).toBe(ideaScore(h));
    expect(h.matrix).toBe(ideaMatrix(h));
    const last = (await storage.hypotheses.history(id)).at(-1);
    expect(last).toMatchObject({
      field: "demand",
      new_value: 2,
      changed_by: "agent:researcher",
      reason: "few buyers found",
    });
    expect(last?.changed_at).toMatch(/^\d{4}-/);
  });

  it("an unchanged failed idea is blocked from being re-raised; a changed one isn't", async () => {
    const storage = await openSqliteStorage(":memory:");
    await importIdeas(storage, FIXTURE, { by: "archie" });
    const h0 = (await storage.hypotheses.list())[0];
    const h = await applyIdeaDecision(storage, h0?.id as string, "Fail", "archie");
    expect(await ideaReraiseBlocked(h, h)).toBe(true);
    expect(await ideaReraiseBlocked(h, { ...h, margin: h.margin === 5 ? 4 : 5 })).toBe(false);
  });
});

describe("idea categories map to brain/taxonomy.md", () => {
  it("covers every category in the file; every mapped node exists in the taxonomy", () => {
    const cats = loadIdeaCategoriesConfig().categories;
    const inFile = new Set(validateIdeasSheet(FULL).rows.map((r) => r.category));
    expect(inFile.size).toBe(25);
    for (const c of inFile) expect(cats[c], c).toBeDefined();
    const nodes = readFileSync(join(ROOT, "brain/taxonomy.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    for (const [c, v] of Object.entries(cats)) if (v.node) expect(nodes, c).toContain(v.node);
  });
});

describe("score edits stick after the first import", () => {
  it("a score changed by Archie or an agent survives a re-import; untouched scores follow the file; both values in history", async () => {
    const storage = await openSqliteStorage(":memory:");
    await importIdeas(storage, FIXTURE, { by: "archie" });
    const id = (await storage.hypotheses.list())[0]?.id as string;
    const orig = (await storage.hypotheses.get(id)) as NonNullable<
      Awaited<ReturnType<typeof storage.hypotheses.get>>
    >;
    const mine = orig.demand === 1 ? 2 : 1;
    await changeIdeaScore(storage, id, "demand", mine, { by: "archie", reason: "few buyers" });
    const row = lines(FIXTURE).findIndex((l) => l.startsWith(`${id},`));
    const newMargin = orig.margin === 1 ? 2 : 1;
    const sheet = editCell(
      editCell(FIXTURE, row, COL("demand"), "5"),
      row,
      COL("margin"),
      String(newMargin),
    );
    const r = await importIdeas(storage, sheet, { by: "archie" });
    const h = await storage.hypotheses.get(id);
    expect(h?.demand).toBe(mine);
    expect(h?.margin).toBe(newMargin);
    expect(h?.score).toBe(ideaScore(h as never));
    expect(h?.matrix).toBe(ideaMatrix(h as never));
    expect(r.scores_kept).toBe(1);
    const demandHist = (await storage.hypotheses.history(id)).filter((x) => x.field === "demand");
    expect(demandHist.map((x) => [x.new_value, x.changed_by])).toEqual([
      [orig.demand, "import"],
      [mine, "archie"],
    ]);
  });
});

describe("every idea has a function and a market", () => {
  it("mapped categories inherit their node; the 220 others carry a per-idea estimate; all values are valid", async () => {
    const { loadIdeaFunctionsConfig } = await import("@ae/config");
    const { ideaFunction, ideaMarket } = await import("../ideas.ts");
    const cats = loadIdeaCategoriesConfig();
    const fns = loadIdeaFunctionsConfig();
    const nodes = readFileSync(join(ROOT, "brain/taxonomy.md"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim());
    const rows = validateIdeasSheet(FULL).rows;
    let estimates = 0;
    for (const r of rows) {
      const f = ideaFunction(r.id, r.category, cats, fns);
      expect(f.function, r.id).not.toBeNull();
      expect([...nodes, "own product"], r.id).toContain(f.function);
      if (cats.categories[r.category]?.node)
        expect(f).toEqual({ function: cats.categories[r.category]?.node, source: "category" });
      else {
        expect(f.source).toBe("estimate");
        estimates++;
      }
      const m = ideaMarket(r);
      expect(m.buyer).toBe(r.buyer);
    }
    expect(estimates).toBe(220);
    // Ideas in a mapped category never carry a per-idea override.
    for (const id of Object.keys(fns.ideas)) {
      const r = rows.find((x) => x.id === id);
      expect(cats.categories[r?.category ?? ""]?.node ?? null, id).toBeNull();
    }
    expect(
      ideaMarket({ buyer: "Local SMEs", category: "Local consumer businesses" }).industry,
    ).toBe("Local consumer businesses");
    expect(ideaMarket({ buyer: "SMEs", category: "SME websites" }).industry).toBeNull();
  });
});
