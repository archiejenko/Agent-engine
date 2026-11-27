import { type InfraConfig, legalDetailsArePlaceholders, tradingDisclosure } from "@ae/config";
import type { EmailSender, Inbox } from "@ae/ports";
import type { EffectRow, Storage, StoredTask } from "@ae/storage";
import { contactBlock, recordContactBlocked } from "./contact.ts";
import { recordOutcome } from "./ledger.ts";
import { receiveEmail } from "./mailbox.ts";
import type { ToolRegistry } from "./tools.ts";

/**
 * Outreach sending (Phase 5) with every guardrail in code (guardrail 5):
 * - one global suppression list (address or whole domain);
 * - UK rules: the sender is identified and an opt-out is included — both appended here, never by a model;
 *   sends where the recipient type is unknown are blocked (only corporate subscribers: companies with a
 *   corporate company type, at a role-based address on the company's own domain);
 * - per-source contact policy: max recipients per send, max attempts without a reply, min days between;
 * - kill switch on → dry run (outbox only); no real sending domain configured → refuse real sends.
 * Refusals are recorded in the outbox as "blocked" with the reason.
 */
export interface SendArgs {
  thread_id: string;
  attempt: number;
  entity_id: string;
  recipients: string[];
  contact_source: string;
  company_type: string | null;
  company_domain: string | null;
  subject: string;
  body: string;
}

const ROLE = /^(info|hello|enquiries|enquiry|contact|sales|office|admin|team)@/i;

export function composeEmail(body: string, cfg: InfraConfig): string {
  const s = cfg.sender;
  return `${body.trim()}\n\n${s.name}\n${s.company}, ${s.address}\n\n${s.opt_out_text}\n\n${tradingDisclosure(s)}`;
}

export async function checkSend(
  storage: Storage,
  cfg: InfraConfig,
  a: SendArgs,
  now = Date.now(),
): Promise<string | null> {
  const policy = cfg.outreach.contact_policy[a.contact_source];
  if (!policy) return `no contact policy for source ${a.contact_source}`;
  if (a.recipients.length === 0) return "no recipient";
  if (a.recipients.length > policy.max_recipients_per_send)
    return `too many recipients (${a.recipients.length} > ${policy.max_recipients_per_send})`;
  if (!a.company_type || !cfg.outreach.corporate_company_types.includes(a.company_type)) {
    return `recipient type unknown or not a corporate subscriber (company type ${a.company_type ?? "unknown"}): needs prior consent`;
  }
  for (const r of a.recipients) {
    if (await storage.suppressions.isSuppressed(r)) return `${r} is on the suppression list`;
    if (!ROLE.test(r)) return `${r} isn't a role-based business address`;
    if (!a.company_domain || !r.toLowerCase().endsWith(`@${a.company_domain.toLowerCase()}`))
      return `${r} isn't on the company's own domain`;
    const history = (await storage.outbox.forRecipient(r)).filter((m) => m.status !== "blocked");
    if (history.length >= policy.max_attempts_without_reply)
      return `${r}: already contacted ${history.length} times without a reply`;
    const last = history.at(-1);
    if (last && now - Date.parse(last.created_at) < policy.min_days_between * 86_400_000)
      return `${r}: contacted less than ${policy.min_days_between} days ago`;
  }
  return null;
}

export function registerOutreachTools(
  registry: ToolRegistry,
  deps: { storage: Storage; cfg: InfraConfig; email: EmailSender; now?: () => number },
) {
  registry.register(
    {
      name: "send_email",
      description: "Send an approved outreach email (operator only). Guardrails enforced in code.",
      allowed_lanes: ["open"],
      external: true,
      serves_customer: false,
      allowed_roles: ["operator"],
      rate_limit_per_min: 30,
      cost_gbp_per_call: 0,
      // The sending provider's key, injected by the registry on live sends only (v3 rule 20).
      keys: ["EMAIL_API_KEY"],
    },
    async (args, { task, dryRun, record }) => {
      const a = args as SendArgs;
      const now = deps.now?.() ?? Date.now();
      const sender = deps.cfg.sender.from_email;
      const body = composeEmail(a.body, deps.cfg);
      let reason = await checkSend(deps.storage, deps.cfg, a, now);
      if (!reason) {
        reason = await contactBlock(deps.storage, deps.cfg, a.entity_id, {
          now: new Date(now),
          taskId: task.task_id,
          threadId: a.thread_id,
        });
        if (reason) {
          const why = reason;
          record((s) => recordContactBlocked(s, a.entity_id, "sme_outreach", why));
        }
      }
      if (!reason && !dryRun && sender.endsWith(".invalid"))
        reason = "no real sending domain configured";
      if (!reason && !dryRun && legalDetailsArePlaceholders(deps.cfg.sender))
        reason = "company number / registered office are still placeholders";
      const recipient = a.recipients.join(",");
      if (reason) {
        const blocked = reason;
        record(async (s) => {
          await s.outbox.add({
            task_id: task.task_id,
            thread_id: a.thread_id,
            attempt: a.attempt,
            entity_id: a.entity_id,
            recipient,
            sender,
            subject: a.subject,
            body,
            status: "blocked",
            reason: blocked,
            synthetic: task.synthetic,
          });
        });
        return { result: { sent: false, blocked: reason } };
      }
      const r = await deps.email.send(
        {
          to: recipient,
          from: sender,
          subject: a.subject,
          body,
          task_id: task.task_id,
          headers: { "List-Unsubscribe": `<mailto:${sender}?subject=unsubscribe>` },
        },
        dryRun,
      );
      // Everything that records the send goes in ONE batch with the effect's result and the cost
      // event (the registry runs it), or nothing is written: the effect then stays unknown and rule 17
      // refuses to send again until someone checks.
      const id = crypto.randomUUID();
      record((s) => recordSend(s, deps.cfg, { a, task, dryRun, id, now, sender, recipient, body }));
      return { result: { sent: !dryRun, dry_run: dryRun, outbox_id: id, provider_id: r.id } };
    },
  );
}

/**
 * What records one send: the outbox row, the "sent" outcome and the follow-up. Used by the send itself
 * (in the registry's after-call batch) and by "mark as sent" on an unknown send, so both write the same
 * rows.
 */
export async function recordSend(
  s: Storage,
  cfg: InfraConfig,
  x: {
    a: SendArgs;
    task: StoredTask;
    dryRun: boolean;
    id: string;
    now: number;
    sender: string;
    recipient: string;
    body: string;
  },
) {
  const { a, task } = x;
  await s.outbox.add({
    id: x.id,
    task_id: task.task_id,
    thread_id: a.thread_id,
    attempt: a.attempt,
    entity_id: a.entity_id,
    recipient: x.recipient,
    sender: x.sender,
    subject: a.subject,
    body: x.body,
    status: x.dryRun ? "dry_run" : "sent",
    reason: null,
    synthetic: task.synthetic,
  });
  // Outcome ledger: one "sent" per email (a dry run is recorded as one and never learned from).
  await recordOutcome(s, cfg, {
    event: "sent",
    entity_id: a.entity_id,
    task,
    source: "outbox",
    dedupe_key: `sent:outbox:${x.id}`,
    dry_run: x.dryRun,
  });
  const policy = cfg.outreach.contact_policy[a.contact_source];
  if (policy && a.attempt < policy.max_attempts_without_reply)
    await s.followups.schedule({
      thread_id: a.thread_id,
      attempt: a.attempt + 1,
      entity_id: a.entity_id,
      opportunity_id: a.thread_id.startsWith("opportunity:")
        ? a.thread_id.slice("opportunity:".length)
        : null,
      due_at: new Date(
        x.now + Math.max(policy.min_days_between, cfg.outreach.followup_days) * 86_400_000,
      ).toISOString(),
    });
}

/**
 * "Mark as sent" for a send whose outcome was unknown (its after-call batch failed): writes the
 * missing outbox row, outcome and follow-up AND settles the effect as done, in one batch. The provider
 * is never called again.
 */
export async function settleUnknownSend(
  storage: Storage,
  cfg: InfraConfig,
  e: EffectRow,
  o: { now?: number } = {},
) {
  const a = e.args as SendArgs | null;
  if (!a?.recipients?.length)
    throw new Error("this send has no recorded arguments to rebuild from");
  const task = await storage.tasks.get(e.task_id);
  if (!task) throw new Error(`no task ${e.task_id}`);
  const reported = (e.result ?? {}) as { outbox_id?: string; provider_id?: string };
  const id = reported.outbox_id ?? crypto.randomUUID();
  const result = {
    sent: !e.dry_run,
    dry_run: e.dry_run,
    outbox_id: id,
    provider_id: reported.provider_id ?? null,
    settled_by: "archie",
  };
  await storage.unit(async (s) => {
    if (!(await s.outbox.get(id)))
      await recordSend(s, cfg, {
        a,
        task,
        dryRun: e.dry_run,
        id,
        now: o.now ?? Date.parse(e.started_at),
        sender: cfg.sender.from_email,
        recipient: a.recipients.join(","),
        body: composeEmail(a.body, cfg),
      });
    await s.effects.finish(e.key, "done", result, "settled by Archie: marked as sent");
  });
  return result;
}

/**
 * Replies (Phase 3 outcomes + Phase 5 sending): a reply to one of our emails becomes an outcome; an
 * opt-out reply adds the sender to the suppression list; either way pending follow-ups are cancelled.
 */
/** Letter opt-out codes as printed: "L" + 6 unambiguous characters (see sme_letter). */
export const LETTER_CODE = /\bL[A-HJ-NP-Z2-9]{6}\b/g;

export async function processInbox(
  storage: Storage,
  cfg: InfraConfig,
  inbox: Inbox,
  since: string,
  event = "positive_reply",
) {
  let replies = 0;
  let optOuts = 0;
  /** Replies to outreach that aren't opt-outs: each gets a post_reply draft (L0). */
  const toAnswer: {
    message: { id: string; from: string; subject: string; body: string; received_at: string };
    entity_id: string;
    thread_id: string;
    synthetic: boolean;
  }[] = [];
  for (const m of await inbox.poll(since)) {
    // Every inbound message is kept in the mailbox (untrusted), linked to the email it answers.
    await receiveEmail(storage, m);
    // A reply to a LETTER quotes its printed opt-out code (letters aren't email threads).
    let letterOptOut = false;
    for (const code of `${m.subject}\n${m.body}`.toUpperCase().match(LETTER_CODE) ?? []) {
      const letter = await storage.letters.byOptOutCode(code);
      if (!letter) continue;
      await storage.suppressions.add(
        `entity:${letter.entity_id}`,
        `letter opt-out by email (${code})`,
      );
      await storage.suppressions.add(m.from, `letter opt-out by email (${code})`);
      letterOptOut = true;
    }
    if (letterOptOut) {
      optOuts++;
      continue;
    }
    const original = m.in_reply_to ? await storage.outbox.get(m.in_reply_to) : null;
    if (!original) continue;
    const text = `${m.subject}\n${m.body}`.toLowerCase();
    const optOut = cfg.outreach.opt_out_phrases.some((p) => text.includes(p));
    await storage.followups.cancelThread(original.thread_id, optOut ? "opted out" : "replied");
    const oppId = original.thread_id.startsWith("opportunity:")
      ? original.thread_id.slice("opportunity:".length)
      : null;
    if (optOut) {
      await storage.suppressions.add(m.from, "replied asking not to be contacted");
      optOuts++;
    }
    await storage.outcomes.add({
      opportunity_id: oppId,
      entity_id: original.entity_id ?? "",
      module: null,
      event,
      value_bool: !optOut,
      value_gbp: null,
      observed_at: m.received_at,
      source: "system",
    });
    // Outcome ledger (v2): every reply, plus reply_positive unless it was an opt-out. Attributed to the
    // task that sent the original email (its cohort arm and synthetic flag come with it).
    if (original.entity_id) {
      const task = original.task_id ? await storage.tasks.get(original.task_id) : null;
      const dryRun = original.status === "dry_run";
      await recordOutcome(storage, cfg, {
        event: "reply",
        entity_id: original.entity_id,
        task,
        source: "inbox",
        dedupe_key: `reply:${m.id}`,
        observed_at: m.received_at,
        dry_run: dryRun,
      });
      if (!optOut)
        await recordOutcome(storage, cfg, {
          event: "reply_positive",
          entity_id: original.entity_id,
          task,
          source: "inbox",
          dedupe_key: `reply_positive:${m.id}`,
          observed_at: m.received_at,
          dry_run: dryRun,
        });
    }
    if (!optOut && original.entity_id && !original.thread_id.startsWith("claim:"))
      toAnswer.push({
        message: {
          id: m.id,
          from: m.from,
          subject: m.subject,
          body: m.body,
          received_at: m.received_at,
        },
        entity_id: original.entity_id,
        thread_id: original.thread_id,
        synthetic: original.task_id
          ? ((await storage.tasks.get(original.task_id))?.synthetic ?? false)
          : false,
      });
    replies++;
  }
  return { replies, opt_outs: optOuts, to_answer: toAnswer };
}
