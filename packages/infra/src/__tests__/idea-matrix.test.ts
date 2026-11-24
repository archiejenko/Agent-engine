import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { IdeaMatrixImportError, importIdeaMatrix, validateIdeaMatrix } from "../idea-matrix.ts";

const SHEET = readFileSync(
  join(import.meta.dirname, "../../../../brain/ideas/ranked-ideas.csv"),
  "utf8",
);
const header = "Rank,Idea,Score,Your build angle,Fit,Speed to £,Demand,Solo-build,List #";

describe("Archie's ranked idea matrix", () => {
  it("reads all 41 ideas with their own four scores; score and rank recomputed match the file", () => {
    const r = validateIdeaMatrix(SHEET);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(41);
    expect(r.mismatches).toEqual([]);
    const top = r.rows[0];
    expect(top).toMatchObject({
      id: "R032",
      rank: 1,
      idea: "Trigger-based cold outreach",
      fit: 5,
      speed_to_cash: 5,
      demand: 5,
      solo_build: 4,
      score: 19,
    });
    expect(r.rows.filter((x) => x.rank === 2)).toHaveLength(2); // a tie shares its rank
    expect(r.rows.find((x) => x.idea === "Day 2, not day 0")?.rank).toBe(4); // the next rank skips
  });

  it("reports a file score or rank that doesn't match the four scores, and doesn't trust it", () => {
    const r = validateIdeaMatrix(`${header}\n1,A,20,angle,5,5,5,4,1\n2,B,10,angle,3,3,3,3,2\n`);
    expect(r.ok).toBe(true);
    expect(r.rows[0]?.score).toBe(19);
    expect(r.mismatches).toContainEqual({ id: "R001", field: "score", file: 20, computed: 19 });
  });

  it("rejects the whole file if any row is invalid, writing nothing", async () => {
    const s = await openSqliteStorage(":memory:");
    const bad = `${header}\n1,A,19,angle,5,5,5,4,1\n2,B,9,angle,6,1,1,1,2\n`;
    await expect(importIdeaMatrix(s, bad, { by: "test" })).rejects.toBeInstanceOf(
      IdeaMatrixImportError,
    );
    expect(await s.ideaMatrix.count()).toBe(0);
  });

  it("imports idempotently, keeps Archie's decisions, and stays out of the outcome ledger", async () => {
    const s = await openSqliteStorage(":memory:");
    expect(await importIdeaMatrix(s, SHEET, { by: "test" })).toMatchObject({
      rows: 41,
      created: 41,
    });
    const db = (s as unknown as { db: { run: (q: string, p?: unknown[]) => Promise<unknown> } }).db;
    await db.run("UPDATE idea_matrix SET decision = 'Pass', comments = 'go' WHERE id = 'R032'");
    expect(await importIdeaMatrix(s, SHEET, { by: "test" })).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 41,
    });
    expect((await s.ideaMatrix.get("R032"))?.decision).toBe("Pass");
    expect((await s.ideaMatrix.list()).every((r) => r.score_source === "estimate")).toBe(true);
    expect(await s.audit.tablesContaining("Trigger-based cold outreach")).not.toContain("outcomes");
  });
});
