import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type VerificationContext } from "@ae/verification";

/**
 * Per-company contact cooldown, across every outreach playbook and every module that feeds them: no
 * new email or letter to a company that was contacted within `contact_cooldown_days`, or that already
 * has an email draft or a letter pending. A follow-up in the same email thread isn't a new contact.
 * Returns the reason it's blocked, or null if the company can be contacted.
 */
export async function contactBlock(
  storage: Storage,
  cfg: InfraConfig,
  entityId: string,
  o: { now?: Date; taskId?: string; threadId?: string } = {},
): Promise<string | null> {
  const now = o.now ?? new Date();
  const since = new Date(
    now.getTime() - cfg.outreach.contact_cooldown_days * 86_400_000,
  ).toISOString();
  const day = (iso: string) => iso.slice(0, 10);

  for (const l of await storage.letters.forEntity(entityId)) {
    if (l.task_id === o.taskId) continue;
    if (l.status === "waiting" || l.status === "batched")
      return `a letter is already pending${l.batch_id ? ` in print batch ${l.batch_id}` : ""}`;
    if (l.status === "approved" && l.created_at >= since)
      return `a letter was sent on ${day(l.created_at)} (cooldown ${cfg.outreach.contact_cooldown_days} days)`;
  }
  for (const m of await storage.outbox.forEntity(entityId)) {
    if (o.threadId && m.thread_id === o.threadId) continue; // follow-up in the same thread
    if (m.created_at >= since)
      return `emailed on ${day(m.created_at)} (cooldown ${cfg.outreach.contact_cooldown_days} days)`;
  }
  for (const t of await storage.tasks.forEntity(entityId)) {
    if (t.task_id === o.taskId || !cfg.outreach.contact_playbooks.includes(t.playbook)) continue;
    const followup = (t.state as { followup?: { thread_id: string } }).followup;
    if (o.threadId && followup?.thread_id === o.threadId) continue;
    if (t.status === "queued" || t.status === "running" || t.status === "awaiting_approval")
      return `${t.playbook === "sme_letter" ? "a letter" : "an email"} draft is already in progress (task ${t.task_id.slice(0, 8)})`;
  }
  return null;
}

/** Records a blocked duplicate so it shows on the Letters page (and in alerts). */
export async function recordContactBlocked(
  storage: Storage,
  entityId: string,
  playbook: string,
  reason: string,
) {
  const name = (await storage.entities.get(entityId))?.name ?? entityId;
  await storage.alerts.raise(
    "contact_blocked",
    `${name} (${entityId}): no new ${playbook === "sme_letter" ? "letter" : "email"}: ${reason}`,
    { entity_id: entityId, playbook, reason },
  );
}

/**
 * Email or letter? Email only with a verified role address from the company's own website and a
 * corporate company type (anything else needs prior consent); otherwise a letter. Routing, not a claim.
 */
export async function outreachRoutes(
  storage: Storage,
  ctx: VerificationContext,
  cfg: InfraConfig,
  entityIds: string[],
): Promise<Map<string, "email" | "letter">> {
  const out = new Map<string, "email" | "letter">(entityIds.map((e) => [e, "letter"]));
  if (!entityIds.length) return out;
  const facts = await getVerifiedFacts(storage, ctx, {
    entities: [...new Set(entityIds)],
    fields: ["contact_email", "company_type"],
    minConfidence: 0,
    asOf: new Date().toISOString(),
    lanes: ["open"],
    caller: "playbook",
  });
  const email = new Set(
    facts
      .filter((f) => f.field === "contact_email" && f.status === "verified")
      .map((f) => f.entity_id),
  );
  for (const f of facts)
    if (
      f.field === "company_type" &&
      typeof f.value === "string" &&
      cfg.outreach.corporate_company_types.includes(f.value) &&
      email.has(f.entity_id)
    )
      out.set(f.entity_id, "email");
  return out;
}
