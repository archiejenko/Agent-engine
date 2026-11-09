import type { InfraConfig } from "@ae/config";
import type { EmailSender, Inbox } from "@ae/ports";
import type { Storage } from "@ae/storage";
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
  return `${body.trim()}\n\n${s.name}\n${s.company}, ${s.address}\n\n${s.opt_out_text}`;
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
    },
    async (args, { task, dryRun }) => {
      const a = args as SendArgs;
      const now = deps.now?.() ?? Date.now();
      const sender = deps.cfg.sender.from_email;
      const body = composeEmail(a.body, deps.cfg);
      let reason = await checkSend(deps.storage, deps.cfg, a, now);
      if (!reason && !dryRun && sender.endsWith(".invalid"))
        reason = "no real sending domain configured";
      const recipient = a.recipients.join(",");
      if (reason) {
        await deps.storage.outbox.add({
          task_id: task.task_id,
          thread_id: a.thread_id,
          attempt: a.attempt,
          entity_id: a.entity_id,
          recipient,
          sender,
          subject: a.subject,
          body,
          status: "blocked",
          reason,
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
      const id = await deps.storage.outbox.add({
        task_id: task.task_id,
        thread_id: a.thread_id,
        attempt: a.attempt,
        entity_id: a.entity_id,
        recipient,
        sender,
        subject: a.subject,
        body,
        status: dryRun ? "dry_run" : "sent",
        reason: null,
      });
      const policy = deps.cfg.outreach.contact_policy[a.contact_source];
      if (policy && a.attempt < policy.max_attempts_without_reply) {
        await deps.storage.followups.schedule({
          thread_id: a.thread_id,
          attempt: a.attempt + 1,
          entity_id: a.entity_id,
          opportunity_id: a.thread_id.startsWith("opportunity:")
            ? a.thread_id.slice("opportunity:".length)
            : null,
          due_at: new Date(
            now + Math.max(policy.min_days_between, deps.cfg.outreach.followup_days) * 86_400_000,
          ).toISOString(),
        });
      }
      return { result: { sent: !dryRun, dry_run: dryRun, outbox_id: id, provider_id: r.id } };
    },
  );
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
  for (const m of await inbox.poll(since)) {
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
    replies++;
  }
  return { replies, opt_outs: optOuts };
}
