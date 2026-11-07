import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedFact } from "@ae/contracts";
import type { CompanyBrief, EmailDraft } from "@ae/infra";
import { explainOpportunity, parseFramework, runModule } from "@ae/opportunity";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts } from "@ae/verification";
import { AgentService, fakeModel, loadPlaybooks } from "../service.ts";
import { buildSyntheticWorld } from "./synthetic-world.ts";

export type GateStatus = "passed (synthetic)" | "passed" | "failed" | "live pending";
export interface GateCriterion {
  criterion: string;
  status: GateStatus;
  evidence: string;
}

const fid = (f: VerifiedFact) => `${f.entity_id}/${f.field}/${f.valid_from}`;

/**
 * Phase 2 gate: top 20 ranked fully traced leads; 50 drafts; every claim in every draft traces to a
 * verified fact; cost per draft reported. Synthetic data + fake model.
 */
export async function runPhase2Gate(
  storage: Storage,
  root: string,
  o: { count: number; drafts: number; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  const model = fakeModel();
  const world = await buildSyntheticWorld(storage, model, { count: o.count, log });
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const asOf = new Date().toISOString().slice(0, 10);
  const run = await runModule(storage, world.ctx, fw, { asOf });
  log(`module: ${run.candidates} scored, ${run.opportunities.length} opportunities`);

  // Explanations for the leads we'll show (model writes from the trace; checked in code).
  const top = run.opportunities.slice(0, Math.max(20, o.drafts));
  let explained = 0;
  for (const opp of top) {
    const e = await explainOpportunity(model, opp);
    await storage.opportunities.setRationale(opp.opportunity_id, e.rationale);
    if (e.used_model) explained++;
  }

  // Criterion 1: top 20 fully traced (every non-neutral signal names facts that exist at asOf).
  const top20 = run.opportunities.slice(0, 20);
  const traceProblems: string[] = [];
  for (const opp of top20) {
    const facts = await getVerifiedFacts(storage, world.ctx, {
      entities: [opp.entity_id],
      fields: [
        ...new Set(opp.trace.flatMap((t) => t.fact_ids.map((id) => id.split("/")[1] as string))),
      ].concat("company_name"),
      minConfidence: 0,
      asOf,
      lanes: ["open"],
      caller: "internal",
    });
    const ids = new Set(facts.map(fid));
    for (const t of opp.trace) {
      if (t.raw_value !== null && t.fact_ids.length === 0)
        traceProblems.push(`${opp.entity_id}.${t.signal_id} has a value but no facts`);
      for (const id of t.fact_ids)
        if (!ids.has(id))
          traceProblems.push(`${opp.entity_id}: ${id} not a verified fact at ${asOf}`);
    }
  }

  // Approve the top N leads → the runner drafts emails (L0: nothing is sent).
  for (const opp of run.opportunities.slice(0, o.drafts))
    await storage.opportunities.setStatus(opp.opportunity_id, "approved");
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
  });
  await service.tick(1000);
  const tasks = await storage.tasks.list({ playbook: "sme_outreach", limit: 1000 });
  const drafts = tasks.filter((t) => t.status === "awaiting_approval");
  const gateDrafts = drafts.filter(
    (t) => (t.state as { awaiting?: { kind: string } }).awaiting?.kind === "gate",
  );

  // Criterion 3: every claim in every draft traces to a verified fact (re-checked independently here).
  const claimProblems: string[] = [];
  let claims = 0;
  for (const t of drafts) {
    const s = t.state as { outputs: { company_brief: CompanyBrief; email_draft: EmailDraft } };
    const brief = s.outputs.company_brief;
    const facts = await getVerifiedFacts(storage, world.ctx, {
      entities: [brief.entity_id],
      fields: [...new Set(brief.facts.map((f) => f.field))].concat("company_name"),
      minConfidence: 0.5,
      asOf: new Date().toISOString(),
      lanes: ["open"],
      caller: "playbook",
    });
    const ids = new Set(facts.map(fid));
    for (const c of s.outputs.email_draft.claims) {
      claims++;
      if (!ids.has(c.fact_id))
        claimProblems.push(`${t.task_id}: "${c.text}" → ${c.fact_id} isn't a verified fact`);
      if (!s.outputs.email_draft.body.includes(c.text))
        claimProblems.push(`${t.task_id}: claim not in body`);
    }
  }
  const totalCost = tasks.reduce((a, t) => a + t.cost_gbp, 0);
  const costPerDraft = tasks.length ? totalCost / tasks.length : 0;

  const criteria: GateCriterion[] = [
    {
      criterion: "Top 20 ranked, fully traced leads",
      status: top20.length >= 20 && traceProblems.length === 0 ? "passed (synthetic)" : "failed",
      evidence: `${top20.length} leads; ${traceProblems.length} trace problems; ${explained}/${top.length} rationales written by the model and passed the check (others used the template)`,
    },
    {
      criterion: `${o.drafts} drafts generated`,
      status: gateDrafts.length >= o.drafts ? "passed (synthetic)" : "failed",
      evidence: `${tasks.length} tasks; ${gateDrafts.length} drafts waiting for approval; ${drafts.length - gateDrafts.length} stopped by the checker for review`,
    },
    {
      criterion: "Every claim in every draft traces to a verified fact",
      status: claims > 0 && claimProblems.length === 0 ? "passed (synthetic)" : "failed",
      evidence: `${claims} claims checked across ${drafts.length} drafts; ${claimProblems.length} problems`,
    },
    {
      criterion: "Cost per draft reported",
      status: "passed (synthetic)",
      evidence: `£${costPerDraft.toFixed(4)} per draft with the fake model's token counts at ${"claude-opus-5-5"}-equivalent prices; website extraction £${(world.extraction_cost_gbp / Math.max(1, world.websites.companies)).toFixed(4)} per company`,
    },
    {
      criterion: "Same, on real data with the real model",
      status: "live pending",
      evidence: "needs CH key, real web fetches and ANTHROPIC_API_KEY (docs/live-cutover.md)",
    },
  ];
  return { criteria, traceProblems, claimProblems, run, cost_per_draft_gbp: costPerDraft, world };
}

export function gateMarkdown(
  phase: string,
  criteria: GateCriterion[],
  notes: string[] = [],
): string {
  return [
    `# Phase ${phase} gate report`,
    "",
    `Generated ${new Date().toISOString()} on SYNTHETIC data with fake external systems.`,
    "",
    "| Criterion | Status | Evidence |",
    "|---|---|---|",
    ...criteria.map((c) => `| ${c.criterion} | ${c.status} | ${c.evidence} |`),
    "",
    ...notes,
    "",
  ].join("\n");
}
