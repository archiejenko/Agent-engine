import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runPhase4Gate } from "../apps/api/src/gates/phase4.ts";
import { log, ROOT } from "./lib.ts";

// Phase 4 gate on synthetic data: writes docs/gates/phase4.md.
const { values } = parseArgs({
  options: {
    count: { type: "string", default: "2000" },
    calls: { type: "string", default: "200" },
    premium: { type: "string", default: "50" },
  },
});
const storage = await openSqliteStorage(":memory:");
const r = await runPhase4Gate(storage, ROOT, {
  count: Number(values.count),
  calls: Number(values.calls),
  premium: Number(values.premium),
  log,
});
const md = gateMarkdown("4", r.criteria, [
  "Prices are placeholders ($0.05 cached, $0.25 premium) until Archie sets them (packages/config/src/products.json).",
]);
writeFileSync(resolve(ROOT, "docs/gates/phase4.md"), md);
console.log(md);
await storage.close();
