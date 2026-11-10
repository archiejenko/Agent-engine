import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type VerificationContext } from "@ae/verification";

export interface ContactStatus {
  /** Why a new email or letter is blocked. */
  reason: string;
  /** When the company was last contacted (YYYY-MM-DD), or null when something is still pending. */
  contacted_on: string | null;
  /** When the cooldown ends (YYYY-MM-DD), or null while something is pending. */
  until: string | null;
}

/**
 * Per-company contact cooldown, across every outreach playbook and every module that feeds them: no
 * new email or letter to a company that was contacted within `contact_cooldown_days`, or that already
 * has an email draft or a letter pending. A follow-up in the same email thread isn't a new contact.
 * Returns why it's blocked (with dates), or null if the company can be contacted.
 */
export async function contactStatus(
  storage: Storage,
  cfg: InfraConfig,
  entityId: string,
  o: { now?: Date; taskId?: string; threadId?: string } = {},
): Promise<ContactStatus | null> {
  const now = o.now ?? new Date();
  const days = cfg.outreach.contact_cooldown_days;
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const day = (iso: string) => iso.slice(0, 10);
  const until = (iso: string) => day(new Date(Date.parse(iso) + days * 86_400_000).toISOString());
  const pending = (reason: string): ContactStatus => ({ reason, contacted_on: null, until: null });
  const contacted = (what: string, iso: string): ContactStatus => ({
    reason: `${what} on ${day(iso)} (cooldown ${days} days)`,
    contacted_on: day(iso),
    until: until(iso),
  });

  for (const l of await storage.letters.forEntity(entityId)) {
    if (l.task_id === o.taskId) continue;
    if (l.status === "waiting" || l.status === "batched")
      return pending(
        `a letter is already pending${l.batch_id ? ` in print batch ${l.batch_id}` : ""}`,
      );
    if (l.status === "approved" && l.created_at >= since)
      return contacted("a letter was sent", l.created_at);
  }
  for (const m of await storage.outbox.forEntity(entityId)) {
    if (o.threadId && m.thread_id === o.threadId) continue; // follow-up in the same thread
    if (m.created_at >= since) return contacted("emailed", m.created_at);
  }
  for (const t of await storage.tasks.forEntity(entityId)) {
    if (t.task_id === o.taskId || !cfg.outreach.contact_playbooks.includes(t.playbook)) continue;
    const followup = (t.state as { followup?: { thread_id: string } }).followup;
    if (o.threadId && followup?.thread_id === o.threadId) continue;
    if (t.status === "queued" || t.status === "running" || t.status === "awaiting_approval")
      return pending(
        `${t.playbook === "sme_letter" ? "a letter" : "an email"} draft is already in progress (task ${t.task_id.slice(0, 8)})`,
      );
  }
  return null;
}

/** The reason a new contact is blocked, or null (see contactStatus). */
export async function contactBlock(
  storage: Storage,
  cfg: InfraConfig,
  entityId: string,
  o: { now?: Date; taskId?: string; threadId?: string } = {},
): Promise<string | null> {
  return (await contactStatus(storage, cfg, entityId, o))?.reason ?? null;
}

export interface BlockedItem {
  entity_id: string;
  name: string;
  playbook: string;
  reason: string;
  at: string;
}

/**
 * Records a blocked duplicate in ONE alert per day ("7 duplicates blocked today"), not one alert each.
 * The same company and reason isn't counted twice on one day. Listed on the Letters page.
 */
export async function recordContactBlocked(
  storage: Storage,
  entityId: string,
  playbook: string,
  reason: string,
  now: Date = new Date(),
) {
  const today = now.toISOString().slice(0, 10);
  const name = (await storage.entities.get(entityId))?.name ?? entityId;
  const item: BlockedItem = { entity_id: entityId, name, playbook, reason, at: now.toISOString() };
  const digest = (await storage.alerts.list({ unacknowledged: true, limit: 500 })).find(
    (a) => a.kind === "contact_blocked" && (a.details as { day?: string } | null)?.day === today,
  );
  const items = [
    ...(((digest?.details as { items?: BlockedItem[] } | null)?.items ?? []) as BlockedItem[]),
  ];
  if (items.some((i) => i.entity_id === entityId && i.reason === reason)) return;
  items.push(item);
  const message = `${items.length} duplicate${items.length === 1 ? "" : "s"} blocked today (one contact per company per cooldown): see Letters`;
  if (digest) await storage.alerts.update(digest.id, message, { day: today, items });
  else await storage.alerts.raise("contact_blocked", message, { day: today, items });
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
