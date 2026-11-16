import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV2Phase1Gate } from "../apps/api/src/gates/v2-phase1.ts";
import { log, ROOT } from "./lib.ts";

// v2 Phase 1 gate, run by the simulator in a sandbox database: writes docs/gates/v2-phase1.md.
const { values } = parseArgs({
  options: {
    count: { type: "string", default: "2000" },
    leads: { type: "string", default: "20" },
    letters: { type: "string", default: "12" },
    db: { type: "string", default: ":memory:" },
  },
});
const storage = await openSqliteStorage(values.db as string);
const r = await runV2Phase1Gate(storage, ROOT, {
  count: Number(values.count),
  leads: Number(values.leads),
  letters: Number(values.letters),
  log,
});
const md = gateMarkdown("v2-1", r.criteria, [
  "Run by the simulator in a sandbox database: every row is synthetic = 1 and is excluded from learning.",
  "Everything external ran as a dry run: the global kill switch defaults to ON (switched off only to serve demo pages, then back on).",
]);
writeFileSync(resolve(ROOT, "docs/gates/v2-phase1.md"), md);
console.log(md);
await storage.close();
