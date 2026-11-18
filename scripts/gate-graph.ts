import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type GateCriterion, gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runGraphG0Gate } from "../apps/api/src/gates/graph-g0.ts";
import { runGraphG1Gate } from "../apps/api/src/gates/graph-g1.ts";
import { ROOT } from "./lib.ts";

// Task graph gates: `pnpm gate:graph --gate N` writes docs/gates/graph-gN.md (graph plan).
const { values } = parseArgs({ options: { gate: { type: "string", default: "0" } } });
const GATES: Record<
  string,
  (s: Awaited<ReturnType<typeof openSqliteStorage>>) => Promise<{ criteria: GateCriterion[] }>
> = {
  "0": (s) => runGraphG0Gate(s, ROOT),
  "1": (s) => runGraphG1Gate(s, ROOT),
};
const run = GATES[values.gate as string];
if (!run) throw new Error(`no graph gate ${values.gate}`);
const storage = await openSqliteStorage(":memory:");
const r = await run(storage);
const md = gateMarkdown(`graph-g${values.gate}`, r.criteria, [
  "Synthetic data, fakes only, dry-run, kill switch on. Nothing external happened.",
]);
writeFileSync(resolve(ROOT, `docs/gates/graph-g${values.gate}.md`), md);
console.log(md);
await storage.close();
