import { dirname, resolve } from "node:path";
import { AgentService, loadPlaybooks } from "@ae/agent-runner";
import { askQuestion, KeyRing, localWorkflowPort } from "@ae/infra";
import { envKeyStore, FakeStripe } from "@ae/ports";
import { FakeFacilitator } from "@ae/products";
import { localRunState } from "@ae/storage/fs";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { fsBrain } from "./brain-fs.ts";

// Composition root for local development: same app, local SQLite file, bound to localhost only.
const dbPath = process.env.AE_DB
  ? resolve(process.env.AE_DB)
  : resolve(import.meta.dirname, "../../../data/dev.sqlite");
const port = Number(process.env.PORT ?? 8787);

const storage = await openSqliteStorage(dbPath);
// Keys locally: .dev.vars values (in the process env) plus anything saved on the Keys page this session.
const keyStore = envKeyStore(process.env);
// Locally the agent runner lives in the same process, so dashboard decisions apply immediately.
const service = new AgentService({
  storage,
  // Graph run state in data/runs.sqlite, closed runs archived in data/blobs (as the Worker's R2).
  ...localRunState(dirname(dbPath)),
  keys: new KeyRing(keyStore, storage),
  playbooks: await loadPlaybooks(resolve(import.meta.dirname, "../../../playbooks")),
});
const app = createApp({
  runtime: "node",
  storage: () => storage,
  // The Vault reads brain/ live from disk locally.
  vault: fsBrain(resolve(import.meta.dirname, "../../..")),
  keys: () => keyStore,
  // Claim fulfilment runs on the local workflow engine (Cloudflare Workflows in production).
  workflows: () => localWorkflowPort(service.workflows),
  decide: (taskId, decision, editedText) => service.decide(taskId, decision, editedText),
  // Questions on idea cards: the planner answers in-process (the fake model until cutover).
  ask: () => (cardId, text, by) =>
    askQuestion({ storage, cfg: service.infra, model: service.model }, cardId, text, by),
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
