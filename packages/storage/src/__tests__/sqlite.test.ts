import { sqliteDriver } from "../sqlite.ts";
import { storageSuite } from "./suite.ts";

storageSuite("SQLite (better-sqlite3)", async () => {
  const driver = sqliteDriver(":memory:");
  return { driver, dispose: () => driver.close() };
});
