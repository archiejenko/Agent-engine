import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type GateCriterion, gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV3Phase1Gate } from "../apps/api/src/gates/v3-phase1.ts";
import { ROOT } from "./lib.ts";

// v3 gates: `pnpm gate:v3 --phase N` writes docs/gates/v3-phaseN.md.
const { values } = parseArgs({ options: { phase: { type: "string", default: "1" } } });
const GATES: Record<
  string,
  (s: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<{ criteria: GateCriterion[] }>
> = {
  "1": (s) => runV3Phase1Gate(s, ROOT),
};
const run = GATES[values.phase as string];
if (!run) throw new Error(`no gate for phase ${values.phase}`);
const storage = await openSqliteStorage(":memory:");
const r = await run(storage);
const md = gateMarkdown(`v3-${values.phase}`, r.criteria, [
  "Synthetic data, fakes only, kill switch on. Nothing external happened.",
]);
writeFileSync(resolve(ROOT, `docs/gates/v3-phase${values.phase}.md`), md);
console.log(md);
await storage.close();
