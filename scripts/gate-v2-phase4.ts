import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gateMarkdown } from "@ae/agent-runner";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { runV2Phase4Gate } from "../apps/api/src/gates/v2-phase4.ts";
import { ROOT } from "./lib.ts";

// v2 Phase 4 gate (claim this site, fulfilment, post_reply): writes docs/gates/v2-phase4.md.
const storage = await openSqliteStorage(":memory:");
const r = await runV2Phase4Gate(storage, ROOT, { count: 1000 });
const md = gateMarkdown("v2-4", r.criteria, [
  "Test mode only: the fake Stripe signs every webhook with the same signature scheme the real one uses; no real card, email or site was touched.",
  "The real Stripe subscription call and the Stripe event field names are NOT verified (Stripe's docs were blocked from the build environment); the real call refuses to run until they are.",
]);
writeFileSync(resolve(ROOT, "docs/gates/v2-phase4.md"), md);
console.log(md);
await storage.close();
