import { sqliteDriver } from "../sqlite.ts";
import { storageSuite } from "./suite.ts";

storageSuite("SQLite (better-sqlite3)", async () => {
  const drivers = {
    core: sqliteDriver(":memory:"),
    facts: sqliteDriver(":memory:"),
    telemetry: sqliteDriver(":memory:"),
  };
  return {
    drivers,
    dispose: async () => {
      for (const d of Object.values(drivers)) await d.close();
    },
  };
});
