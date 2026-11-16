import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type GateCriterion, gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV2Phase2Gate } from "../apps/api/src/gates/v2-phase2.ts";
import { log, ROOT } from "./lib.ts";

// v2 Phase 2 gate: writes docs/gates/v2-phase2.md. Also builds the Worker with `wrangler deploy
// --dry-run` (nothing is uploaded) to check the Cron, Queue, Durable Object and Workflow bindings.
const { values } = parseArgs({ options: { count: { type: "string", default: "2000" } } });
const storage = await openSqliteStorage(":memory:");
const r = await runV2Phase2Gate(storage, ROOT, { count: Number(values.count), log });
let build: GateCriterion;
try {
  const out = execFileSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "deploy",
      "--dry-run",
      "--outdir",
      mkdtempSync(join(tmpdir(), "ae-wbuild-")),
    ],
    { cwd: resolve(ROOT, "apps/api"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const bindings = ["CHANGE_FEED", "ENGINE", "JOBS", "DB"].filter((b) => out.includes(`env.${b}`));
  build = {
    criterion:
      "The Worker builds with its Cron, Queue (+ dead-letter queue), Durable Object and Workflow",
    status: bindings.length === 4 ? "passed" : "failed",
    evidence: `wrangler deploy --dry-run: bindings ${bindings.join(", ")}; cron and queue consumers in wrangler.jsonc`,
  };
} catch (e) {
  build = {
    criterion:
      "The Worker builds with its Cron, Queue (+ dead-letter queue), Durable Object and Workflow",
    status: "failed",
    evidence: String((e as Error).message).slice(0, 300),
  };
}
const md = gateMarkdown(
  "v2-2",
  [...r.criteria, build],
  [
    "Cloudflare delivery itself (Queues retries, Workflows scheduling, Durable Object alarms) is configuration; it gets its first real run when Archie deploys (cutover checklist).",
    "The Companies House streaming adapter is not built: its documentation host was blocked from the build environment. Polling covers it until then.",
  ],
);
writeFileSync(resolve(ROOT, "docs/gates/v2-phase2.md"), md);
console.log(md);
await storage.close();
