import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runPhase5Gate } from "../apps/api/src/gates/phase5.ts";
import { log, ROOT } from "./lib.ts";

// Phase 5 gate on synthetic data: writes docs/gates/phase5.md.
const { values } = parseArgs({
  options: { count: { type: "string", default: "2000" }, leads: { type: "string", default: "20" } },
});
const storage = await openSqliteStorage(":memory:");
const r = await runPhase5Gate(storage, ROOT, {
  count: Number(values.count),
  leads: Number(values.leads),
  log,
});
const md = gateMarkdown("5", r.criteria, [
  "Everything external ran as a dry run: the global kill switch defaults to ON.",
]);
writeFileSync(resolve(ROOT, "docs/gates/phase5.md"), md);
console.log(md);
await storage.close();
