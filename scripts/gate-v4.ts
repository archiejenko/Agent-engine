import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type GateCriterion, gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV4Phase1Gate } from "../apps/api/src/gates/v4-phase1.ts";
import { ROOT } from "./lib.ts";

// v4 gates (PLAN.md §8): `pnpm gate:v4 --phase N` writes docs/gates/v4-phaseN.md.
const { values } = parseArgs({ options: { phase: { type: "string", default: "1" } } });
const GATES: Record<
  string,
  (s: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<{ criteria: GateCriterion[] }>
> = {
  "1": (s) => runV4Phase1Gate(s, ROOT),
};
const run = GATES[values.phase as string];
if (!run) throw new Error(`no v4 gate for phase ${values.phase}`);
const storage = await openSqliteStorage(":memory:");
const r = await run(storage);
const md = gateMarkdown(`v4-phase${values.phase}`, r.criteria, [
  "Synthetic world (fake Companies House files through the normal pipeline, fake model), the real 500 seed ideas, and fake source adapters that count their calls. Nothing external happened.",
]);
writeFileSync(resolve(ROOT, `docs/gates/v4-phase${values.phase}.md`), md);
console.log(md);
if (r.criteria.some((c) => c.status === "failed")) process.exit(1);
