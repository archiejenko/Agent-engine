import { describe, expect, it } from "vitest";
import { migrate, rollback } from "../migrate.ts";
import { loadDownMigrations, loadMigrations } from "../migrations-fs.ts";
import { openSqliteStorage, sqliteDriver } from "../sqlite.ts";

const M = "0023_v3_ideas.sql";

describe("ideas migration (0023)", () => {
  it("runs up, down and up again", async () => {
    const all = loadMigrations();
    const db = sqliteDriver(":memory:");
    await migrate(db, all);
    const tables = async () =>
      (
        await db.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('scout_signals','idea_cards','idea_thread','board_tiles','board_moves','experiments') ORDER BY name",
        )
      ).map((r) => r.name);
    expect(await tables()).toHaveLength(6);
    await rollback(
      db,
      all.find((m) => m.name === M) as never,
      loadDownMigrations().get(M) as string,
    );
    expect(await tables()).toHaveLength(0);
    expect(await migrate(db, all)).toEqual([M]);
    expect(await tables()).toHaveLength(6);
  });
});

describe("ideas storage", () => {
  it("keeps every card version, lists the latest, and never edits the thread", async () => {
    const s = await openSqliteStorage(":memory:");
    for (const version of [1, 2])
      await s.ideaCards.add({
        card_id: "card-test-1",
        version,
        hypothesis_id: null,
        market_key: "m",
        card: { v: version },
        status: version === 1 ? "superseded" : "proposed",
        rank_value: version,
        synthetic: true,
      });
    expect((await s.ideaCards.versions("card-test-1")).map((c) => c.version)).toEqual([1, 2]);
    expect((await s.ideaCards.list()).map((c) => c.version)).toEqual([2]);
    await s.ideaThread.add({
      card_id: "card-test-1",
      version: 1,
      kind: "question",
      author: "archie",
      text: "why?",
      evidence: [],
    });
    const db = (s as unknown as { db: { run: (q: string) => Promise<unknown> } }).db;
    await expect(db.run("UPDATE idea_thread SET text = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.run("DELETE FROM idea_thread")).rejects.toThrow(/append-only/);
  });

  it("records every Board move", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.board.ensure({ market_key: "m", label: "M", field: "f", col: "scanning", by: "scout" });
    expect(await s.board.move("m", "researching", "planner", "card raised")).toBe(true);
    expect(await s.board.move("m", "researching", "planner", "again")).toBe(false);
    expect((await s.board.moves("m")).map((m) => `${m.from_col}->${m.to_col}`)).toEqual([
      "null->scanning",
      "scanning->researching",
    ]);
  });
});
