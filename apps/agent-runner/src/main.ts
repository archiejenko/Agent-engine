import { resolve } from "node:path";
import { localWorkflowPort } from "@ae/infra";
import { openSqliteStorage } from "@ae/storage/sqlite";
import {
  handleJob,
  type JobRuntime,
  LocalJobQueue,
  recordDeadLetter,
  scheduledJobs,
} from "./jobs.ts";
import { loadPlaybooks } from "./load-playbooks.ts";
import { planPendingCards, startApprovedPlans } from "./planner.ts";
import { AgentService } from "./service.ts";

// One scheduled run against the local database, through the same jobs the Worker's cron enqueues
// (fakes; nothing external happens). Failing jobs retry 3 times, then become dead letters.
const root = resolve(import.meta.dirname, "../../..");
const storage = await openSqliteStorage(process.env.AE_DB ?? resolve(root, "data/dev.sqlite"));
const service = new AgentService({
  storage,
  playbooks: await loadPlaybooks(resolve(root, "playbooks")),
  // Same switch as the Worker's var: "1" turns the task graph layer on (off by default).
  graphEngine: { enabled: process.env.GRAPH_ENGINE_ENABLED === "1" },
});
const rt: JobRuntime = {
  service,
  send: (job) => queue.send(job),
  refresh: async () => false, // no Companies House key locally
  workflows: service.workflows,
  workflowPort: localWorkflowPort(service.workflows),
};
const queue: LocalJobQueue = new LocalJobQueue(
  (job) => handleJob(rt, job),
  (job, attempts, error) =>
    recordDeadLetter(storage, { queue: "local", body: job, attempts, error }),
);
for (const job of scheduledJobs()) await queue.send(job);
console.log(`ran ${await queue.drain()} job(s)`);
// Task graph G4: plan passed ideas (each sandbox run gets a fresh in-memory database), and give each
// approved plan its task. Runs here (Node) because the sandbox needs a throwaway SQLite database.
const plans = await planPendingCards({
  service,
  sandboxStorage: () => openSqliteStorage(":memory:"),
});
const started = await startApprovedPlans(service);
console.log(`planned ${plans.length} idea(s); ${started} approved plan(s) started`);
await storage.close();
