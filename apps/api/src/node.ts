import { resolve } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

// Composition root for local development: same app, local SQLite file, bound to localhost only.
const dbPath = process.env.AE_DB
  ? resolve(process.env.AE_DB)
  : resolve(import.meta.dirname, "../../../data/dev.sqlite");
const port = Number(process.env.PORT ?? 8787);

const storage = await openSqliteStorage(dbPath);
const app = createApp({ runtime: "node", storage: () => storage });

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`API running on http://127.0.0.1:${info.port} (database: ${dbPath})`);
});
