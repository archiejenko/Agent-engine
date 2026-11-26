import { resolve } from "node:path";
import { openSqliteStorage, storePaths } from "@ae/storage/sqlite";

// Applies pending migrations to the local databases (data layer plan, step 2): data/dev.sqlite (core),
// data/dev-facts.sqlite, data/dev-telemetry.sqlite, plus the local-only data/dev-runtime.sqlite. An
// older single-file dev.sqlite is split on first open, with its rows copied into the new files.
const path = resolve(import.meta.dirname, "../data/dev.sqlite");
const storage = await openSqliteStorage(path);
console.log(`Migrations applied: ${JSON.stringify((await storage.health()).databases)}`);
await storage.close();
console.log(`Databases: ${Object.values(storePaths(path)).join(", ")}`);
