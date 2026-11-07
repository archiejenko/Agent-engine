import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { gateMarkdown, runPhase2Gate } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { log, ROOT } from "./lib.ts";

// Phase 2 gate on synthetic data (no keys): writes docs/gates/phase2.md.
const { values } = parseArgs({
  options: {
    count: { type: "string", default: "3000" },
    drafts: { type: "string", default: "50" },
  },
});
const storage = await openSqliteStorage(":memory:");
const r = await runPhase2Gate(storage, ROOT, {
  count: Number(values.count),
  drafts: Number(values.drafts),
  log,
});
const md = gateMarkdown("2", r.criteria, [
  `Synthetic world: ${values.count} companies → ${r.run.candidates} scored leads, ${r.run.opportunities.length} above threshold or exploration picks.`,
  `Top 5: ${r.run.opportunities
    .slice(0, 5)
    .map((o) => `${o.entity_id} (${o.score.toFixed(2)})`)
    .join(", ")}.`,
  r.traceProblems.length ? `Trace problems: ${r.traceProblems.slice(0, 10).join("; ")}` : "",
  r.claimProblems.length ? `Claim problems: ${r.claimProblems.slice(0, 10).join("; ")}` : "",
]);
writeFileSync(resolve(ROOT, "docs/gates/phase2.md"), md);
console.log(md);
await storage.close();
