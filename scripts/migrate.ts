import { resolve } from "node:path";
import { migrate } from "@ae/storage";
import { loadMigrations } from "@ae/storage/migrations-fs";
import { sqliteDriver } from "@ae/storage/sqlite";

// Applies pending migrations to the local database file (data/dev.sqlite).
const path = resolve(import.meta.dirname, "../data/dev.sqlite");
const driver = sqliteDriver(path);
const applied = await migrate(driver, loadMigrations());
await driver.close();
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database up to date.");
console.log(`Database: ${path}`);
