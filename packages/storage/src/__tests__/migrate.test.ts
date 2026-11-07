import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "../migrate.ts";

describe("splitSqlStatements", () => {
  it("splits on ; and keeps trigger bodies whole", () => {
    const sql = `-- comment
CREATE TABLE a (x INTEGER);
CREATE TRIGGER t BEFORE UPDATE ON a
BEGIN
  SELECT RAISE(ABORT, 'no');
END;
CREATE INDEX i ON a (x);`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(3);
    expect(out[1]).toContain("RAISE(ABORT, 'no');");
    expect(out[1]?.trim().endsWith("END;")).toBe(true);
  });
  it("throws on an unterminated statement", () => {
    expect(() => splitSqlStatements("CREATE TABLE a (x INTEGER)")).toThrow(/unterminated/);
  });
});
