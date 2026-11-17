import type { DecisionsConfig, InfraConfig } from "@ae/config";
import type { DecisionOption, DecisionRow, Storage } from "@ae/storage";
import { defaultContext, resolveConflict, type VerificationContext } from "@ae/verification";
import { promotePlaybook } from "./autonomy.ts";
import { type SpendTier, setSpendTier } from "./budget.ts";
import { contactStatus } from "./contact.ts";
import { estimatePaid } from "./ev.ts";
import { recordOutcome } from "./ledger.ts";
import { decidePrintBatch } from "./playbooks/sme_letter.ts";
import type { WorkflowPort } from "./workflow.ts";

/**
 * The Needs-you queue (v3 rules 18–19). Everything that needs Archie is a decision with options, a
 * recommended option, a SAFE DEFAULT (spends nothing, sends nothing) and a deadline. Archie's choice
 * goes through ONE path (`decide`), which writes exactly one owner approval and then applies the option.
 * A deadline that passes applies the safe default directly: no owner approval and no approval-history row
 * is written, and the decision is recorded as "defaulted". This file is the only creator of owner
 * approvals (a test enforces it).
 */
export interface DecisionDeps {
  storage: Storage;
  cfg: InfraConfig;
  dcfg: DecisionsConfig;
  /** Applies a draft decision in the runner (local). Absent on Workers: the runner applies it next tick. */
  decideTask?: (
    taskId: string,
    d: "approve" | "edit" | "reject",
    text: string | null,
  ) => Promise<unknown>;
  workflows?: WorkflowPort;
  vctx?: VerificationContext;
  now?: () => Date;
}

const opt = (key: string, label: string, effect: string): DecisionOption => ({
  key,
  label,
  effect,
});
const deadline = (d: DecisionDeps, type: string) =>
  new Date(
    (d.now?.() ?? new Date()).getTime() + (d.dcfg.deadline_hours[type] ?? 168) * 3_600_000,
  ).toISOString();

// ---- Sources → open decisions (idempotent: one open decision per type + source).

export async function syncDecisions(d: DecisionDeps): Promise<number> {
  const { storage, cfg } = d;
  let opened = 0;
  const open = async (x: Parameters<Storage["decisions"]["open"]>[0]) => {
    const before = await storage.decisions.openFor(x.type, x.source_ref);
    if (!before) {
      await storage.decisions.open(x);
      opened++;
    }
  };
  const fyv = cfg.measurement.priors.first_year_value_gbp;
  const name = async (id: string) => (await storage.entities.get(id))?.name ?? id;

  // Leads (actionable modules, not blocked by the contact cooldown), best first, capped.
  const leads = (await storage.opportunities.list({ status: "proposed", limit: 5000 }))
    .filter((o) => cfg.playbook_for_module[o.module])
    .sort((a, b) => b.expected_value_gbp - a.expected_value_gbp);
  let n = 0;
  for (const o of leads) {
    if (n >= d.dcfg.max_open_leads) break;
    if (await contactStatus(storage, cfg, o.entity_id)) continue;
    n++;
    await open({
      type: "lead",
      source_ref: `opportunity:${o.opportunity_id}`,
      summary: `Lead: ${await name(o.entity_id)} (score ${o.score.toFixed(2)})`,
      money_at_stake_gbp: o.expected_value_gbp,
      money_kind: "estimated",
      options: [
        opt(
          "approve",
          "Approve",
          "drafts an email or letter for your review (nothing is sent yet)",
        ),
        opt("skip", "Skip", "no contact"),
      ],
      recommended: "approve",
      safe_default: "skip",
      deadline: deadline(d, "lead"),
      context: {
        entity_id: o.entity_id,
        module: o.module,
        rationale: o.rationale,
        explore: o.explore,
      },
      synthetic: false,
    });
  }

  // Drafts waiting for review (emails and replies; letters go by print batch, claims by workflow).
  for (const t of await storage.tasks.list({ status: "awaiting_approval", limit: 500 })) {
    if (t.playbook === "sme_letter" || t.playbook === "claim_site") continue;
    const entity = t.source_ref.match(/:entity:([A-Z0-9]{8})$/)?.[1] ?? "";
    const st = t.state as {
      awaiting?: { kind: string; item: unknown };
      outputs?: { company_brief?: unknown };
    };
    const est = await estimatePaid(storage, cfg, t.playbook);
    await open({
      type: "draft",
      source_ref: `task:${t.task_id}`,
      // Blind (rule 22): nothing here says how the task was created.
      summary: `${t.playbook === "post_reply" ? "Reply" : "Email"} draft for ${await name(entity)}`,
      money_at_stake_gbp: Number(
        ((t.playbook === "post_reply" ? est.p_close : est.p_paid) * fyv).toFixed(2),
      ),
      money_kind: "estimated",
      options: [
        opt("approve", "Approve", "sends it (as a dry run while the kill switch is on)"),
        opt("reject", "Reject", "nothing is sent"),
      ],
      recommended: st.awaiting?.kind === "check_failed" ? "reject" : "approve",
      safe_default: "reject",
      deadline: deadline(d, "draft"),
      context: {
        task_id: t.task_id,
        entity_id: entity,
        playbook: t.playbook,
        awaiting: st.awaiting ?? null,
        brief: st.outputs?.company_brief ?? null,
        cost_gbp: t.cost_gbp,
      },
      synthetic: t.synthetic,
    });
  }

  // Print batches.
  for (const b of (await storage.printBatches.list(20)).filter((x) => x.status === "pending")) {
    const letters = await storage.letters.list({ batchId: b.id, limit: 1000 });
    const est = await estimatePaid(storage, cfg, "sme_letter");
    const cost = cfg.letters.print_cost_gbp + cfg.letters.postage_gbp;
    await open({
      type: "print_batch",
      source_ref: `batch:${b.id}`,
      summary: `Print batch ${b.week}: ${letters.length} letters (£${(letters.length * cost).toFixed(2)} to print and post)`,
      money_at_stake_gbp: Number((letters.length * est.p_paid * fyv).toFixed(2)),
      money_kind: "estimated",
      options: [
        opt(
          "approve",
          "Approve batch",
          "you print and post it; demo pages go live when external actions are on",
        ),
        opt("reject", "Reject batch", "nothing is printed"),
      ],
      recommended: "approve",
      safe_default: "reject",
      deadline: deadline(d, "print_batch"),
      context: {
        batch_id: b.id,
        letters: letters.map((l) => ({
          task_id: l.task_id,
          company: l.company_name,
          flags: l.flags,
        })),
        flagged: letters.filter((l) => l.flags.length).length,
      },
      synthetic: letters.some((l) => (l as unknown as { synthetic?: boolean }).synthetic),
    });
  }

  // Claimed sites ready to publish.
  for (const c of (await storage.siteClaims.list({ includeSynthetic: true, limit: 500 })).filter(
    (x) => x.status === "awaiting_publish",
  ))
    await open({
      type: "claim_publish",
      source_ref: `claim:${c.id}`,
      summary: `Publish the site for ${await name(c.entity_id)}`,
      money_at_stake_gbp: Number((c.setup_fee_gbp + 12 * c.monthly_gbp).toFixed(2)),
      money_kind: "real",
      options: [
        opt("publish", "Approve and publish", "the site goes live on its sample address"),
        opt(
          "not_yet",
          "Not yet",
          "nothing is published; fulfilment stops and the claim needs a fresh look",
        ),
      ],
      recommended: "publish",
      safe_default: "not_yet",
      deadline: deadline(d, "claim_publish"),
      context: { claim_id: c.id, details: c.details },
      synthetic: c.synthetic,
    });

  // External actions with an unknown outcome (never repeated until settled).
  for (const e of await storage.effects.unresolved(100))
    await open({
      type: "uncertain_effect",
      source_ref: `effect:${e.key}`,
      summary: `Did "${e.tool}" happen? (task ${e.task_id.slice(0, 8)})`,
      money_at_stake_gbp: 0,
      money_kind: "none",
      options: [
        opt("happened", "It happened", "recorded as done; never repeated"),
        opt("did_not_happen", "It didn't happen", "the step may try once more"),
        opt("leave", "Leave it", "stays blocked; never repeated"),
      ],
      recommended: "leave",
      safe_default: "leave",
      deadline: deadline(d, "uncertain_effect"),
      context: { key: e.key, tool: e.tool, error: e.error, started_at: e.started_at },
      synthetic: false,
    });

  // Failed jobs set aside.
  for (const x of await storage.deadLetters.list({ open: true, limit: 50 }))
    await open({
      type: "dead_letter",
      source_ref: `dead_letter:${x.id}`,
      summary: `A ${(x.body as { kind?: string })?.kind ?? "job"} failed ${x.attempts} times`,
      money_at_stake_gbp: 0,
      money_kind: "none",
      options: [opt("set_aside", "Dealt with", "removed from the list")],
      recommended: "set_aside",
      safe_default: "set_aside",
      deadline: deadline(d, "dead_letter"),
      context: { error: x.error, body: x.body },
      synthetic: false,
    });

  // Fact conflicts and quarantined matches.
  for (const f of (await storage.facts.listCurrent({ status: "conflict", limit: 50, offset: 0 }))
    .rows) {
    const values: unknown[] = [];
    for (const cid of [...f.supporting_claims, ...f.conflicting_claims]) {
      const cl = await storage.claims.get(cid);
      if (cl && !values.some((v) => JSON.stringify(v) === JSON.stringify(cl.value)))
        values.push(cl.value);
    }
    await open({
      type: "data_conflict",
      source_ref: `fact:${f.entity_id}:${f.field}`,
      summary: `Conflicting ${f.field.replace(/_/g, " ")} for ${await name(f.entity_id)}`,
      money_at_stake_gbp: 0,
      money_kind: "none",
      options: [
        ...values
          .slice(0, 5)
          .map((v, i) =>
            opt(
              `value_${i}`,
              `Use ${JSON.stringify(v).slice(0, 60)}`,
              "recorded as a human-verified claim",
            ),
          ),
        opt("leave", "Leave as conflict", "nothing changes"),
      ],
      recommended: "leave",
      safe_default: "leave",
      deadline: deadline(d, "data_conflict"),
      context: { entity_id: f.entity_id, field: f.field, values: values.slice(0, 5) },
      synthetic: false,
    });
  }
  for (const q of await storage.quarantine.listOpen(50))
    await open({
      type: "quarantine",
      source_ref: `quarantine:${q.id}`,
      summary: `Unmatched record from ${q.source}: ${q.raw_ref}`,
      money_at_stake_gbp: 0,
      money_kind: "none",
      options: [
        opt("not_a_match", "Not a match", "dropped"),
        opt("leave", "Leave it", "stays in quarantine"),
      ],
      recommended: "not_a_match",
      safe_default: "leave",
      deadline: deadline(d, "quarantine"),
      context: { reason: q.reason },
      synthetic: false,
    });

  await supersedeStale(d);
  return opened;
}

/** Open decisions whose source no longer needs Archie (e.g. a task that moved on) are closed. */
async function supersedeStale(d: DecisionDeps) {
  const { storage } = d;
  for (const x of await storage.decisions.list({ status: "open", limit: 1000 })) {
    const [kind, id] = [
      x.source_ref.split(":")[0],
      x.source_ref.slice(x.source_ref.indexOf(":") + 1),
    ];
    let live = true;
    if (kind === "task") live = (await storage.tasks.get(id))?.status === "awaiting_approval";
    else if (kind === "opportunity")
      live = (await storage.opportunities.get(id))?.status === "proposed";
    else if (kind === "batch") live = (await storage.printBatches.get(id))?.status === "pending";
    else if (kind === "claim")
      live = (await storage.siteClaims.get(id))?.status === "awaiting_publish";
    else if (kind === "effect")
      live = ["started", "unknown"].includes((await storage.effects.get(id))?.status ?? "");
    if (!live)
      await storage.decisions.close(x.id, {
        status: "superseded",
        chosen_option: null,
        decided_by: "system",
      });
  }
}

// ---- Deciding: the one path for Archie, and the safe default on expiry.

export class DecisionError extends Error {}

/**
 * Archie decides. Writes ONE owner approval (the record of Archie's choice), closes the decision, then applies
 * the option. `payload` carries an edited draft text or letters to leave out of a batch.
 */
export async function decide(
  d: DecisionDeps,
  id: string,
  option: string,
  by: string,
  payload: { edited_text?: string | null; exclude?: string[] } = {},
): Promise<DecisionRow> {
  const x = await d.storage.decisions.get(id);
  if (!x) throw new DecisionError("not_found");
  if (x.status !== "open") throw new DecisionError(`already_${x.status}`);
  if (!x.options.some((o) => o.key === option)) throw new DecisionError("unknown_option");
  const approvalId = await d.storage.ownerApprovals.add({
    kind: "decision",
    subject: x.source_ref,
    value: { decision_id: x.id, type: x.type, option, payload },
    approved_by: by,
    note: null,
    decision_id: x.id,
  });
  if (
    !(await d.storage.decisions.close(x.id, {
      status: "decided",
      chosen_option: option,
      decided_by: by,
      approval_id: approvalId,
    }))
  )
    throw new DecisionError("already_decided");
  try {
    await apply(d, x, option, { approvalId, payload, defaulted: false });
  } catch (e) {
    await d.storage.decisions.setError(x.id, (e as Error).message);
    throw e;
  }
  return (await d.storage.decisions.get(x.id)) as DecisionRow;
}

/** Deadlines that have passed take their safe default. Never an owner approval; recorded as "defaulted". */
export async function expireDecisions(d: DecisionDeps): Promise<number> {
  const now = (d.now?.() ?? new Date()).toISOString();
  let n = 0;
  for (const x of await d.storage.decisions.expired(now)) {
    if (
      !(await d.storage.decisions.close(x.id, {
        status: "defaulted",
        chosen_option: x.safe_default,
        decided_by: "default",
      }))
    )
      continue;
    try {
      await apply(d, x, x.safe_default, { approvalId: null, payload: {}, defaulted: true });
    } catch (e) {
      await d.storage.decisions.setError(x.id, (e as Error).message);
    }
    n++;
  }
  return n;
}

/**
 * Opens a decision for something Archie asked for on the dashboard (raise a spend tier, change autonomy)
 * and decides it straight away: one tap, same recorded path.
 */
export async function requestAndDecide(
  d: DecisionDeps,
  r: {
    type: "spend_tier" | "autonomy";
    source_ref: string;
    summary: string;
    option: string;
    options: DecisionOption[];
    context?: unknown;
  },
  by: string,
) {
  const x = await d.storage.decisions.open({
    type: r.type,
    source_ref: r.source_ref,
    summary: r.summary,
    money_at_stake_gbp: 0,
    money_kind: "none",
    options: r.options,
    recommended: r.option,
    safe_default:
      r.options.find((o) => o.key.startsWith("keep"))?.key ??
      (r.options.at(-1) as DecisionOption).key,
    deadline: deadline(d, r.type),
    context: r.context ?? null,
    synthetic: false,
  });
  return decide(d, x.id, r.option, by);
}

async function apply(
  d: DecisionDeps,
  x: DecisionRow,
  option: string,
  o: {
    approvalId: string | null;
    payload: { edited_text?: string | null; exclude?: string[] };
    defaulted: boolean;
  },
) {
  const { storage, cfg } = d;
  const id = x.source_ref.slice(x.source_ref.indexOf(":") + 1);
  switch (x.type) {
    case "lead":
      await storage.opportunities.setStatus(id, option === "approve" ? "approved" : "rejected");
      return;
    case "draft": {
      if (o.defaulted) {
        // Not Archie's rejection: cancel without writing to the approval history (rule 19).
        await storage.tasks.update(id, {
          status: "cancelled",
          error: "defaulted: no decision before the deadline",
        });
        return;
      }
      const edited = o.payload.edited_text ?? null;
      const choice = option === "reject" ? "reject" : edited ? "edit" : "approve";
      if (d.decideTask) await d.decideTask(id, choice, edited);
      else {
        const t = await storage.tasks.get(id);
        if (t?.status === "awaiting_approval")
          await storage.tasks.update(id, {
            state: {
              ...t.state,
              pending_decision: {
                decision: choice,
                edited_text: edited,
                at: new Date().toISOString(),
              },
            },
          });
      }
      return;
    }
    case "print_batch": {
      if (o.defaulted) {
        const letters = await storage.letters.list({ batchId: id, limit: 1000 });
        await storage.letters.setStatus(
          letters.map((l) => l.task_id),
          "rejected",
        );
        for (const l of letters)
          await storage.tasks.update(l.task_id, {
            status: "cancelled",
            error: "defaulted: batch not approved in time",
          });
        await storage.printBatches.decide(id, "rejected");
        return;
      }
      const decision = option === "approve" ? "approve" : "reject";
      const r = await decidePrintBatch(
        storage,
        cfg,
        id,
        decision,
        o.payload.exclude ?? [],
        async (taskId, dd) => {
          if (d.decideTask) return d.decideTask(taskId, dd, null);
          const t = await storage.tasks.get(taskId);
          if (t?.status === "awaiting_approval")
            await storage.tasks.update(taskId, {
              state: {
                ...t.state,
                pending_decision: { decision: dd, edited_text: null, at: new Date().toISOString() },
              },
            });
        },
      );
      if (decision === "approve")
        for (const l of await storage.letters.list({
          batchId: id,
          status: "approved",
          limit: 1000,
        }))
          await recordOutcome(storage, cfg, {
            event: "sent",
            entity_id: l.entity_id,
            task: await storage.tasks.get(l.task_id),
            source: "letters",
            dedupe_key: `sent:letter:${l.task_id}`,
            dry_run: !r.demo_links_live,
          });
      return;
    }
    case "claim_publish": {
      const claim = await storage.siteClaims.get(id);
      if (!claim?.workflow_id || !d.workflows) throw new Error("no workflow to tell");
      await d.workflows.sendEvent(claim.workflow_id, "publish_decision", {
        approve: option === "publish",
        ...(o.defaulted ? { defaulted: true } : {}),
      });
      return;
    }
    case "uncertain_effect": {
      const e = await storage.effects.get(id);
      if (!e || option === "leave") return;
      await storage.effects.finish(
        e.key,
        option === "happened" ? "done" : "not_happened",
        e.result,
        `settled by Archie: ${option === "happened" ? "it happened" : "it did not happen"}`,
      );
      return;
    }
    case "dead_letter":
      await storage.deadLetters.resolve(id);
      return;
    case "data_conflict": {
      if (option === "leave") return;
      const values = (x.context as { values: unknown[] }).values;
      const v = values[Number(option.replace("value_", ""))];
      const [entity, field] = id.split(":") as [string, string];
      await resolveConflict(storage, d.vctx ?? defaultContext(), entity, field, v as never);
      return;
    }
    case "quarantine":
      if (option === "not_a_match") await storage.quarantine.resolve(id, null);
      return;
    case "spend_tier": {
      // source_ref "spend_tier:<playbook>:<tier>"; only "raise" changes anything.
      if (o.defaulted || option !== "raise") return;
      const [playbook, tier] = id.split(":") as [string, SpendTier];
      await setSpendTier(storage, playbook, tier, {
        approvalId: o.approvalId as string,
        by: x.decided_by ?? "archie",
      });
      return;
    }
    case "autonomy": {
      // source_ref "autonomy:<playbook>"; context.base = the playbook's own level.
      if (o.defaulted || option !== "promote") return;
      const base = ((x.context as { base?: string } | null)?.base ?? "L0") as "L0";
      await promotePlaybook(storage, id, base, cfg, "archie (dashboard)", o.approvalId as string);
      return;
    }
    default:
      throw new Error(`no handler for decision type ${x.type}`);
  }
}

/** Ranked open queue (money at stake, then deadline) after syncing and expiring. */
export async function needsYou(d: DecisionDeps, o: { type?: string; limit?: number } = {}) {
  await syncDecisions(d);
  await expireDecisions(d);
  return d.storage.decisions.list({
    status: "open",
    ...(o.type ? { type: o.type } : {}),
    limit: o.limit ?? 200,
  });
}

/** Decides the open decision for a source (used by the old approve buttons, which now go through here). */
export async function decideSource(
  d: DecisionDeps,
  type: string,
  sourceRef: string,
  option: string,
  by: string,
  payload: { edited_text?: string | null; exclude?: string[] } = {},
) {
  let x = await d.storage.decisions.openFor(type, sourceRef);
  if (!x) {
    await syncDecisions(d);
    x = await d.storage.decisions.openFor(type, sourceRef);
  }
  if (!x) throw new DecisionError("no_open_decision");
  return decide(d, x.id, option, by, payload);
}
