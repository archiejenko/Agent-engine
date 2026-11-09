import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentService,
  fakeModel,
  loadPlaybooks,
  runPhase2Gate,
  runPhase3Gate,
} from "@ae/agent-runner";
import { createPrintBatch, K } from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { defaultContext, getVerifiedFacts } from "@ae/verification";
import { runPhase4Gate } from "../../apps/api/src/gates/phase4.ts";
import { runPhase5Gate } from "../../apps/api/src/gates/phase5.ts";
import { log, ROOT } from "../lib.ts";

/**
 * Seeds data/screens.sqlite for the screenshot record: runs the Phase 2–5 gates (each builds the
 * Phase 1 synthetic world first) into ONE database, then leaves a few things waiting for Archie so
 * every page has something to show: email drafts in Review and a print batch awaiting approval.
 * Synthetic data and fakes only: no network, no real sends. The global kill switch ends ON.
 */
const DB = resolve(ROOT, process.env.AE_DB ?? "data/screens.sqlite");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) rmSync(f);
const storage = await openSqliteStorage(DB);
const scratch = mkdtempSync(join(tmpdir(), "ae-screens-"));
const results: Record<string, string[]> = {};
const record = (
  phase: string,
  r: { criteria: { criterion: string; status: string; evidence: string }[] },
) => {
  results[phase] = r.criteria.map(
    (c) => `${c.status}: ${c.criterion}${c.status === "failed" ? ` — ${c.evidence}` : ""}`,
  );
};

async function topUp() {
  // Top-up: a few fresh leads approved so Review has email drafts and Letters has a pending batch.
  log("top-up: drafts and a pending print batch");
  const ctx = defaultContext();
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(ROOT, "playbooks")),
    model: fakeModel(),
  });
  const fw = await parseFramework(
    readFileSync(join(ROOT, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const asOf = new Date().toISOString();
  const run = await runModule(storage, ctx, fw, { asOf });
  // Companies that already have a task (from the gates) are skipped, so nothing is duplicated.
  const tasked = new Set(
    (await storage.tasks.list({ limit: 100_000 })).map((t) => t.source_ref.split(":").pop()),
  );
  const fresh = run.opportunities.filter((o) => !tasked.has(o.entity_id));
  const contacts = new Set(
    (
      await getVerifiedFacts(storage, ctx, {
        entities: fresh.map((o) => o.entity_id),
        fields: ["contact_email"],
        minConfidence: 0,
        asOf,
        lanes: ["open"],
        caller: "internal",
      })
    ).map((f) => f.entity_id),
  );
  const picks = [
    ...fresh.filter((o) => contacts.has(o.entity_id)).slice(0, 4),
    ...fresh.filter((o) => !contacts.has(o.entity_id)).slice(0, 6),
  ];
  for (const o of picks) await storage.opportunities.setStatus(o.opportunity_id, "approved");
  await service.tick(200);
  const batch = await createPrintBatch(storage, service.infra, { force: true });
  return batch;
}

// Order matters in one shared database: lead_gen_sme_web is still in pilot, so approved leads are
// capped (50 a week), and the Phase 3 gate's outcome data uses up most of that allowance. So: Phase 5
// first (it approves the print batch it makes), then Phase 2, then the top-up (drafts left waiting in
// Review and a print batch left pending), then the x402 and measurement gates.
log("phase 5 gate");
record("5", await runPhase5Gate(storage, ROOT, { count: 1200, leads: 8, letters: 6, log }));
log("phase 2 gate");
record("2", await runPhase2Gate(storage, ROOT, { count: 1200, drafts: 12, log }));
const batch = await topUp();
log("phase 4 gate");
record("4", await runPhase4Gate(storage, ROOT, { count: 1200, calls: 60, premium: 10, log }));
log("phase 3 gate");
record("3", await runPhase3Gate(storage, ROOT, { count: 1200, golden: 100, outDir: scratch, log }));
await storage.controls.set(K.global, true, "screens-seed"); // external actions stay OFF

const waiting = await storage.tasks.list({ status: "awaiting_approval", limit: 500 });
log(
  `seeded ${DB}: ${waiting.filter((t) => t.playbook === "sme_outreach").length} email drafts waiting, ` +
    `pending batch ${batch?.id ?? "none"}, kill switch ON`,
);
console.log(JSON.stringify({ db: DB, gates: results, pending_batch: batch?.id ?? null }, null, 2));
await storage.close();
rmSync(scratch, { recursive: true, force: true });
