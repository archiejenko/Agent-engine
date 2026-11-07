import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateMarkdown, runPhase3Gate } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { log, ROOT } from "./lib.ts";

// Phase 3 gate on synthetic data: writes docs/gates/phase3.md (+ example outputs in docs/gates/phase3-outputs).
const { values } = parseArgs({
  options: {
    count: { type: "string", default: "3000" },
    golden: { type: "string", default: "150" },
  },
});
const storage = await openSqliteStorage(":memory:");
const outDir = resolve(ROOT, "docs/gates/phase3-outputs");
const r = await runPhase3Gate(storage, ROOT, {
  count: Number(values.count),
  golden: Number(values.golden),
  outDir,
  log,
});
const md = gateMarkdown("3", r.criteria, [
  "Example outputs (synthetic) are in `docs/gates/phase3-outputs/`: the framework note copy with the suggested change, the module digest and the margin report.",
]);
writeFileSync(resolve(ROOT, "docs/gates/phase3.md"), md.split(`${ROOT}/`).join(""));
console.log(md.split(`${ROOT}/`).join(""));
await storage.close();
