import { resolve } from "node:path";
import { AgentService, loadPlaybooks } from "@ae/agent-runner";
import { FakeStripe } from "@ae/ports";
import { FakeFacilitator } from "@ae/products";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

// Composition root for local development: same app, local SQLite file, bound to localhost only.
const dbPath = process.env.AE_DB
  ? resolve(process.env.AE_DB)
  : resolve(import.meta.dirname, "../../../data/dev.sqlite");
const port = Number(process.env.PORT ?? 8787);

const storage = await openSqliteStorage(dbPath);
// Locally the agent runner lives in the same process, so dashboard decisions apply immediately.
const service = new AgentService({
  storage,
  playbooks: await loadPlaybooks(resolve(import.meta.dirname, "../../../playbooks")),
});
const app = createApp({
  runtime: "node",
  storage: () => storage,
  decide: (taskId, decision, editedText) => service.decide(taskId, decision, editedText),
  // Locally x402 uses the FAKE facilitator (no money moves; localhost only).
  // Locally card payments use FAKE Stripe (no money moves).
  payments: {
    provider: new FakeStripe("whsec_local"),
    webhookSecret: "whsec_local",
    publicBaseUrl: `http://127.0.0.1:${port}`,
  },
  x402: {
    facilitator: new FakeFacilitator(),
    payTo: process.env.X402_PAY_TO ?? "0x0000000000000000000000000000000000000001",
  },
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`API running on http://127.0.0.1:${info.port} (database: ${dbPath})`);
});
