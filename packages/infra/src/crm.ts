import type { CompanyActivity, Storage } from "@ae/storage";
import { blindLedgerRow, blindTask } from "./blind.ts";

/**
 * CRM (v3 Phase 1): one row per company, derived in code from the ledger, letters, claims, suppressions,
 * opportunities and open tasks. No CRM table: the stage is always what the records say.
 * The holdout stays hidden (rule 22): ledger rows and tasks go through the blind serializers.
 */
export const CRM_STAGES = [
  "new",
  "contacted",
  "engaged",
  "replied",
  "claimed",
  "customer",
  "lost",
  "opted_out",
] as const;
export type CrmStage = (typeof CRM_STAGES)[number];

export function stageOf(a: CompanyActivity): CrmStage {
  if (a.opted_out) return "opted_out";
  const c = a.claim?.status;
  if (c === "published" || c === "paid" || c === "details_received" || c === "awaiting_publish")
    return "customer";
  if (c === "cancelled" || c === "refunded" || a.events.churned) return "lost";
  if (c === "checkout_started" || a.events.checkout_started) return "claimed";
  if (a.events.reply || a.events.reply_positive || a.events.booking) return "replied";
  if (a.events.qr_scan || a.events.demo_visit) return "engaged";
  if (a.events.sent || (a.letters.approved ?? 0) > 0) return "contacted";
  return "new";
}

export interface CrmRow {
  entity_id: string;
  name: string;
  stage: CrmStage;
  expected_value_gbp: number | null;
  value_kind: "real" | "estimated" | null;
  last_contact: string | null;
  next_step: string;
  owner_agent: string | null;
  synthetic: boolean;
}

const NEXT: Record<CrmStage, string> = {
  new: "Approve or skip the lead",
  contacted: "Wait for a reply or follow-up",
  engaged: "They looked at the sample: wait or follow up",
  replied: "Answer their reply",
  claimed: "Waiting for payment",
  customer: "Keep the site running",
  lost: "Nothing (lost)",
  opted_out: "Never contact again",
};

export function toCrmRow(a: CompanyActivity): CrmRow {
  const stage = stageOf(a);
  const open = a.open_tasks[0];
  const nextStep = open
    ? open.status === "awaiting_approval"
      ? `Your review: ${open.playbook} draft`
      : open.status === "running"
        ? `${open.playbook} in progress`
        : `${open.playbook} queued`
    : NEXT[stage];
  const customerValue = a.claim && stage === "customer" ? a.claim.monthly_gbp * 12 : null;
  const contactTimes = [a.events.sent, a.events.reply].filter(Boolean) as string[];
  return {
    entity_id: a.entity_id,
    name: a.name ?? a.entity_id,
    stage,
    expected_value_gbp: customerValue ?? a.opportunity?.expected_value_gbp ?? null,
    value_kind: customerValue !== null ? "real" : a.opportunity ? "estimated" : null,
    last_contact: contactTimes.sort().at(-1) ?? null,
    next_step: stage === "opted_out" ? NEXT.opted_out : nextStep,
    owner_agent: open?.playbook ?? null,
    synthetic: a.synthetic,
  };
}

export async function crmList(
  storage: Storage,
  o: {
    search?: string;
    stage?: CrmStage;
    includeSynthetic: boolean;
    limit: number;
    offset: number;
  },
) {
  const rows = (await storage.crm.activity({ includeSynthetic: o.includeSynthetic })).map(toCrmRow);
  const q = o.search?.trim().toLowerCase();
  const filtered = rows
    .filter((r) => !q || r.name.toLowerCase().includes(q) || r.entity_id.toLowerCase().includes(q))
    .filter((r) => !o.stage || r.stage === o.stage)
    .sort(
      (a, b) =>
        (b.last_contact ?? "").localeCompare(a.last_contact ?? "") ||
        (b.expected_value_gbp ?? 0) - (a.expected_value_gbp ?? 0),
    );
  const counts = Object.fromEntries(
    CRM_STAGES.map((s) => [s, rows.filter((r) => r.stage === s).length]),
  );
  return { total: filtered.length, counts, rows: filtered.slice(o.offset, o.offset + o.limit) };
}

/** One company's full history: contacts, ledger events, tasks, claims, opt-out (all blind). */
export async function crmCompany(storage: Storage, id: string, includeSynthetic: boolean) {
  const activity =
    (await storage.crm.activity({ includeSynthetic })).find((a) => a.entity_id === id) ?? null;
  const emails = (await storage.outbox.forEntity(id)).map((m) => ({
    id: m.id,
    channel: "email" as const,
    to: m.recipient,
    subject: m.subject,
    status: m.status,
    reason: m.reason,
    at: m.created_at,
  }));
  const letters = (await storage.letters.forEntity(id)).map((l) => ({
    id: l.task_id,
    channel: "letter" as const,
    to: l.address.join(", "),
    subject: "Letter to The Directors",
    status: l.status,
    reason: l.flags.map((f) => f.detail).join("; ") || null,
    at: l.created_at,
  }));
  const ledger = (await storage.ledgerForEntity(id))
    .filter((r) => includeSynthetic || !r.synthetic)
    .map(blindLedgerRow);
  const tasks = (await storage.tasks.forEntity(id))
    .filter((t) => includeSynthetic || !t.synthetic)
    .map(blindTask)
    .map((t) => ({
      task_id: t.task_id,
      playbook: t.playbook,
      status: t.status,
      cost_gbp: t.cost_gbp,
      revenue_gbp: t.revenue_gbp,
      updated_at: t.updated_at,
    }));
  const claims = (await storage.siteClaims.list({ includeSynthetic, limit: 10_000 }))
    .filter((c) => c.entity_id === id)
    .map(({ details_token: _t, ...c }) => c);
  return {
    row: activity ? toCrmRow(activity) : null,
    opted_out: activity?.opted_out ?? (await storage.suppressions.isSuppressed(`entity:${id}`)),
    contacts: [...emails, ...letters].sort((a, b) => b.at.localeCompare(a.at)),
    ledger,
    tasks,
    claims,
  };
}

/** CSV export (no holdout fields, no contact bodies). */
export function crmCsv(rows: CrmRow[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const cols: (keyof CrmRow)[] = [
    "entity_id",
    "name",
    "stage",
    "expected_value_gbp",
    "value_kind",
    "last_contact",
    "next_step",
    "owner_agent",
    "synthetic",
  ];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}
