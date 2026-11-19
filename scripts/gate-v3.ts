import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type GateCriterion, gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV3Phase1Gate } from "../apps/api/src/gates/v3-phase1.ts";
import { runV3Phase2Gate } from "../apps/api/src/gates/v3-phase2.ts";
import { runV3Phase3Gate } from "../apps/api/src/gates/v3-phase3.ts";
import { runV3Phase4Gate } from "../apps/api/src/gates/v3-phase4.ts";
import { runV3Phase5Gate } from "../apps/api/src/gates/v3-phase5.ts";
import { runV3Phase6Gate } from "../apps/api/src/gates/v3-phase6.ts";
import { runV3SeedGate } from "../apps/api/src/gates/v3-seed.ts";
import { ROOT } from "./lib.ts";

// v3 gates: `pnpm gate:v3 --phase N` writes docs/gates/v3-phaseN.md.
const { values } = parseArgs({ options: { phase: { type: "string", default: "1" } } });
const GATES: Record<
  string,
  (s: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<{ criteria: GateCriterion[] }>
> = {
  "1": (s) => runV3Phase1Gate(s, ROOT),
  "2": (s) => runV3Phase2Gate(s, ROOT),
  "3": (s) => runV3Phase3Gate(s, ROOT),
  "4": (s) => runV3Phase4Gate(s),
  "5": (s) => runV3Phase5Gate(s, ROOT),
  "6": (s) => runV3Phase6Gate(s, ROOT),
  seed: (s) => runV3SeedGate(s, ROOT),
};
const run = GATES[values.phase as string];
if (!run) throw new Error(`no gate for phase ${values.phase}`);
const storage = await openSqliteStorage(":memory:");
const r = await run(storage);
const md = gateMarkdown(`v3-${values.phase}`, r.criteria, [
  "Synthetic data, fakes only, kill switch on. Nothing external happened.",
]);
const file = /^\d+$/.test(values.phase as string)
  ? `v3-phase${values.phase}`
  : `v3-${values.phase}`;
writeFileSync(resolve(ROOT, `docs/gates/${file}.md`), md);
console.log(md);
await storage.close();
