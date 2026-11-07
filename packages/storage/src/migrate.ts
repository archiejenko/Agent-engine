import type { SqlDriver, SqlStatement } from "./driver.ts";

export interface Migration {
  /** File name, e.g. 0001_core.sql. Order is by name. */
  name: string;
  sql: string;
}

/**
 * Split a migration file into statements. Statements end with a line ending in ';',
 * except inside CREATE TRIGGER ... BEGIN ... END; blocks. Comment-only lines are dropped.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  let inTrigger = false;
  for (const rawLine of sql.split("\n")) {
    const line = rawLine.replace(/--.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    current.push(line);
    if (/^\s*CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    const endsStatement = inTrigger ? /^\s*END\s*;\s*$/i.test(line) : line.endsWith(";");
    if (endsStatement) {
      statements.push(current.join("\n"));
      current = [];
      inTrigger = false;
    }
  }
  if (current.join("").trim() !== "") {
    throw new Error("migration ends with an unterminated statement (missing ';')");
  }
  return statements;
}

/**
 * Apply pending migrations. Uses the same bookkeeping table as `wrangler d1 migrations`
 * (d1_migrations), so local SQLite and D1 agree on what has been applied.
 */
export async function migrate(driver: SqlDriver, migrations: Migration[]): Promise<string[]> {
  await driver.run(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  const applied = new Set(
    (await driver.all<{ name: string }>("SELECT name FROM d1_migrations")).map((r) => r.name),
  );
  const pending = [...migrations]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((m) => !applied.has(m.name));
  for (const m of pending) {
    const statements: SqlStatement[] = splitSqlStatements(m.sql).map((sql) => ({ sql }));
    statements.push({ sql: "INSERT INTO d1_migrations (name) VALUES (?)", params: [m.name] });
    await driver.batch(statements);
  }
  return pending.map((m) => m.name);
}
