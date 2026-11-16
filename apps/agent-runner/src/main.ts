import { resolve } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import {
  handleJob,
  type JobRuntime,
  LocalJobQueue,
  recordDeadLetter,
  scheduledJobs,
} from "./jobs.ts";
import { loadPlaybooks } from "./load-playbooks.ts";
import { AgentService } from "./service.ts";

// One scheduled run against the local database, through the same jobs the Worker's cron enqueues
// (fakes; nothing external happens). Failing jobs retry 3 times, then become dead letters.
const root = resolve(import.meta.dirname, "../../..");
const storage = await openSqliteStorage(process.env.AE_DB ?? resolve(root, "data/dev.sqlite"));
const service = new AgentService({
  storage,
  playbooks: await loadPlaybooks(resolve(root, "playbooks")),
});
const rt: JobRuntime = {
  service,
  send: (job) => queue.send(job),
  refresh: async () => false, // no Companies House key locally
};
const queue: LocalJobQueue = new LocalJobQueue(
  (job) => handleJob(rt, job),
  (job, attempts, error) =>
    recordDeadLetter(storage, { queue: "local", body: job, attempts, error }),
);
for (const job of scheduledJobs()) await queue.send(job);
console.log(`ran ${await queue.drain()} job(s)`);
await storage.close();
