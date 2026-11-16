import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV2Phase3Gate } from "../apps/api/src/gates/v2-phase3.ts";
import { ROOT } from "./lib.ts";

// v2 Phase 3 gate (hard budgets): writes docs/gates/v2-phase3.md.
const storage = await openSqliteStorage(":memory:");
const r = await runV2Phase3Gate(storage, ROOT);
const md = gateMarkdown("v2-3", r.criteria, [
  "The budget ledger here is the same code the Budget Durable Object runs, behind an in-process lock; on Cloudflare the Durable Object's one-call-at-a-time execution gives the same guarantee.",
]);
writeFileSync(resolve(ROOT, "docs/gates/v2-phase3.md"), md);
console.log(md);
await storage.close();
