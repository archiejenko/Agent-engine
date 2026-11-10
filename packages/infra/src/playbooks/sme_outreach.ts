import { type InfraConfig, loadInfraConfig } from "@ae/config";
import type { VerifiedFact } from "@ae/contracts";
import type { ModelRequest } from "@ae/ports";
import type { PlaybookImpl, RoleImpl, TaskState } from "../runner.ts";

/**
 * sme_outreach v1. Truthfulness (guardrail 3): the writer may only state facts from the brief, each
 * claim names its fact, and the checker verifies every claim — and that no unsupported number or date
 * appears — in code.
 */
export interface BriefFact {
  fact_id: string;
  field: string;
  statement: string;
  /** A token that must appear in any claim using this fact. */
  key: string;
  confidence: number;
}

export interface CompanyBrief {
  entity_id: string;
  company_name: string;
  facts: BriefFact[];
  /** Who we'd write to (not a claim): role-based website address, company type, website domain. */
  contact: {
    email: string | null;
    company_type: string | null;
    domain: string | null;
    source: "company_website";
  };
}

export interface EmailDraft {
  subject: string;
  body: string;
  claims: { fact_id: string; text: string }[];
}

export const BRIEF_FIELDS = [
  "company_name",
  "incorporation_date",
  "website_found",
  "website_url",
  "website_copyright_year",
  "website_https",
  "website_mobile_ready",
  "job_postings",
  "officer_appointments",
  "employees_average",
  "contact_email",
  "company_type",
];

const fid = (f: VerifiedFact) => `${f.entity_id}/${f.field}/${f.valid_from}`;

/** Deterministic plain-English statements for facts (no model involved). */
export function statementFor(
  f: VerifiedFact,
  asOf: Date,
): { statement: string; key: string } | null {
  const v = f.value;
  switch (f.field) {
    case "incorporation_date":
      return typeof v === "string"
        ? { statement: `has been trading since ${v.slice(0, 4)}`, key: v.slice(0, 4) }
        : null;
    case "website_found":
      return v === false
        ? { statement: "doesn't seem to have a website yet", key: "website" }
        : null;
    case "website_copyright_year":
      return typeof v === "number" && asOf.getUTCFullYear() - v >= 3
        ? { statement: `has a website that still shows a ${v} copyright date`, key: String(v) }
        : null;
    case "website_https":
      return v === false
        ? { statement: "has a website that isn't served securely (no HTTPS)", key: "HTTPS" }
        : null;
    case "website_mobile_ready":
      return v === false
        ? { statement: "has a website that isn't set up for mobile phones", key: "mobile" }
        : null;
    case "job_postings":
      return Array.isArray(v) && v.length
        ? {
            statement: `is currently advertising ${v.length} ${v.length === 1 ? "role" : "roles"}`,
            key: String(v.length),
          }
        : null;
    case "officer_appointments": {
      const recent =
        Array.isArray(v) &&
        v.some(
          (o) =>
            typeof (o as { appointed_on?: string }).appointed_on === "string" &&
            asOf.getTime() - Date.parse((o as { appointed_on: string }).appointed_on) <
              90 * 86_400_000,
        );
      return recent
        ? { statement: "has recently appointed a new director", key: "director" }
        : null;
    }
    case "employees_average":
      return typeof v === "number"
        ? { statement: `employs around ${v} people`, key: String(v) }
        : null;
    default:
      return null;
  }
}

/** Facts the email may state must be at least this confident. Routing fields (contact) only need to be verified. */
export const STATEMENT_MIN_CONFIDENCE = 0.5;

export function buildBrief(entityId: string, facts: VerifiedFact[], asOf: Date): CompanyBrief {
  const name = facts.find((f) => f.field === "company_name")?.value;
  const out: BriefFact[] = [];
  const neverLead = new Set(loadInfraConfig().outreach.copy_rules.never_lead_with_fields);
  for (const f of facts) {
    if (f.confidence < STATEMENT_MIN_CONFIDENCE) continue;
    // Copy rule: never lead with director/officer/ownership changes, so they aren't offered at all.
    if (neverLead.has(f.field)) continue;
    const s = statementFor(f, asOf);
    if (s) out.push({ fact_id: fid(f), field: f.field, ...s, confidence: f.confidence });
  }
  const str = (field: string) => {
    const v = facts.find((f) => f.field === field)?.value;
    return typeof v === "string" ? v : null;
  };
  return {
    entity_id: entityId,
    company_name: typeof name === "string" ? name : entityId,
    facts: out,
    contact: {
      email: str("contact_email"),
      company_type: str("company_type"),
      domain: str("website_url"),
      source: "company_website",
    },
  };
}

type CopyRules = InfraConfig["outreach"]["copy_rules"];

/** Sentences of the body after the greeting line ("Hi there,"). */
export function bodySentences(body: string): string[] {
  const lines = body.trim().split("\n");
  const rest =
    /,\s*$/.test(lines[0] ?? "") && (lines[0] ?? "").length < 40 ? lines.slice(1) : lines;
  return rest
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

const count = (hay: string, needle: string) =>
  needle ? hay.toLowerCase().split(needle.toLowerCase()).length - 1 : 0;

/**
 * Copy rules (checked in code): one factual observation; company name at most twice; "I noticed" at
 * most once; never lead with director/officer changes; structure observation → why it matters →
 * offer (the opt-out is added by code after the body).
 */
export function checkCopyRules(
  draft: EmailDraft,
  brief: CompanyBrief,
  rules: CopyRules = loadInfraConfig().outreach.copy_rules,
): string[] {
  const reasons: string[] = [];
  const claims = draft.claims ?? [];
  if (claims.length > rules.max_observations)
    reasons.push(
      `${claims.length} factual observations (max ${rules.max_observations}): keep to one`,
    );
  const short = brief.company_name.replace(/\s+(LIMITED|LTD\.?|PLC|LLP)$/i, "");
  const text = `${draft.subject ?? ""}\n${draft.body ?? ""}`;
  const mentions = count(text.split(brief.company_name).join(short), short);
  if (mentions > rules.max_company_name_mentions)
    reasons.push(`company name used ${mentions} times (max ${rules.max_company_name_mentions})`);
  const noticed = count(draft.body ?? "", "i noticed");
  if (noticed > rules.max_i_noticed) reasons.push(`"I noticed" used ${noticed} times`);
  const byId = new Map(brief.facts.map((f) => [f.fact_id, f]));
  for (const c of claims) {
    const field = byId.get(c.fact_id)?.field ?? c.fact_id.split("/")[1] ?? "";
    if (rules.never_lead_with_fields.includes(field))
      reasons.push(`leads with a director/officer change (${field}); never lead with those`);
  }
  const sentences = bodySentences(draft.body ?? "");
  const first = (sentences[0] ?? "").toLowerCase();
  if (rules.never_lead_with_words.some((w) => first.includes(w)))
    reasons.push("the first sentence is about directors/officers; never lead with those");
  const claimAt = claims[0] ? sentences.findIndex((x) => x.includes(claims[0]?.text ?? "")) : -1;
  if (claims[0] && claimAt !== 0)
    reasons.push("structure: open with the one observation (it must be the first sentence)");
  const offerAt = sentences.findIndex((x) =>
    rules.offer_markers.some((m) => x.toLowerCase().includes(m)),
  );
  if (offerAt < 0) reasons.push("structure: no offer (demo, ideas or a short call)");
  else if (offerAt - Math.max(claimAt, 0) - 1 < rules.min_sentences_before_offer)
    reasons.push("structure: say why it matters to them before the offer");
  return reasons;
}

/** The truth check and copy rules, in code. Returns reasons for failure (empty = pass). */
export function checkDraft(draft: EmailDraft, brief: CompanyBrief): string[] {
  const reasons: string[] = [...checkCopyRules(draft, brief)];
  const byId = new Map(brief.facts.map((f) => [f.fact_id, f]));
  if (!draft.subject?.trim() || !draft.body?.trim()) reasons.push("subject and body are required");
  for (const c of draft.claims ?? []) {
    const f = byId.get(c.fact_id);
    if (!f) reasons.push(`claim "${c.text}" cites a fact that isn't in the brief`);
    else if (!c.text.toLowerCase().includes(f.key.toLowerCase()))
      reasons.push(`claim "${c.text}" doesn't match its fact (${f.statement})`);
    if (!draft.body.includes(c.text)) reasons.push(`claim "${c.text}" isn't in the email body`);
  }
  // Anything that looks like a factual number or date must come from a checked claim.
  const supported = (draft.claims ?? []).map((c) => c.text).join(" ");
  // The company's own name (with or without "Limited"/"Ltd") isn't a factual claim.
  const short = brief.company_name.replace(/\s+(LIMITED|LTD\.?|PLC|LLP)$/i, "");
  const bodyWithoutName = draft.body.split(brief.company_name).join(" ").split(short).join(" ");
  for (const m of bodyWithoutName.matchAll(/\b\d[\d,.]*\b/g)) {
    if (!supported.includes(m[0])) reasons.push(`unsupported number or date "${m[0]}"`);
  }
  if (/\[[^\]]*\]|\{[^}]*\}|TODO|lorem/i.test(draft.body)) reasons.push("contains a placeholder");
  const words = draft.body.trim().split(/\s+/).length;
  if (words > 180) reasons.push(`too long (${words} words, max 180)`);
  if ((draft.claims ?? []).length === 0)
    reasons.push("no checked claims: the email must be about this company");
  return [...new Set(reasons)];
}

export const WRITER_PROMPT = {
  id: "sme_outreach_draft",
  version: 2,
  system: `You write a short, friendly first email from Archie (a Manchester web designer) to a small business.
Use exactly ONE statement from the brief, copied word for word, as the first sentence, and list it in "claims" with its fact_id.
Then one or two sentences on why that matters to them (no facts, numbers or dates), then the offer: a few ideas or a short call.
Mention the company name at most twice, including the subject. Don't write "I noticed" more than once.
Never open with, or mention, director, officer or ownership changes.
Do not add any other facts, numbers, dates, names or compliments. No placeholders. Under 120 words.
Do not write a sign-off, sender details or unsubscribe line: those are added automatically.
Return JSON: {"subject": string, "body": string, "claims": [{"fact_id": string, "text": string}]}.`,
};

export const SME_OUTREACH: PlaybookImpl = {
  roles: {
    research: (async (ctx) => {
      const entityId = String(ctx.task.source_ref.split(":").pop());
      const r = await ctx.tools.call("verified_facts", {
        entities: [entityId],
        fields: BRIEF_FIELDS,
        minConfidence: 0, // statements are filtered to ≥ 0.5 in buildBrief; contact needs only verified
      });
      const brief = buildBrief(entityId, r.result as VerifiedFact[], new Date());
      return { output: brief };
    }) satisfies RoleImpl,

    draft: (async (ctx) => {
      const brief = ctx.inputs.company_brief as CompanyBrief;
      const req: ModelRequest = {
        prompt_id: WRITER_PROMPT.id,
        prompt_version: WRITER_PROMPT.version,
        role: "writer",
        system: WRITER_PROMPT.system,
        user: JSON.stringify({
          brief,
          examples_of_archies_edits: ctx.examples,
          ...((ctx.task.state as { followup?: { attempt: number } }).followup
            ? {
                followup_attempt: (ctx.task.state as { followup: { attempt: number } }).followup
                  .attempt,
              }
            : {}),
          ...(ctx.retryReason ? { previous_attempt_failed_because: ctx.retryReason } : {}),
        }),
        max_tokens: 1000,
      };
      const res = await ctx.model.complete(req);
      let draft: EmailDraft;
      try {
        draft = JSON.parse(res.text) as EmailDraft;
      } catch {
        draft = { subject: "", body: res.text, claims: [] };
      }
      return { output: draft, model: res.model, usage: res.usage };
    }) satisfies RoleImpl,

    check: (async (ctx) => {
      const brief = ctx.inputs.company_brief as CompanyBrief;
      const draft = ctx.inputs.email_draft as EmailDraft;
      // Re-read the facts now (they may have changed since research) and confirm each claim still holds.
      const r = await ctx.tools.call("verified_facts", {
        entities: [brief.entity_id],
        fields: BRIEF_FIELDS,
        minConfidence: 0, // statements are filtered to ≥ 0.5 in buildBrief; contact needs only verified
      });
      const current = buildBrief(brief.entity_id, r.result as VerifiedFact[], new Date());
      const reasons = checkDraft(draft, current);
      return {
        output: { passed: reasons.length === 0, reasons },
        check: { passed: reasons.length === 0, reasons },
      };
    }) satisfies RoleImpl,
    send: (async (ctx) => {
      const brief = ctx.inputs.company_brief as CompanyBrief;
      const draft = ctx.inputs.email_draft as EmailDraft;
      const followup = (ctx.task.state as { followup?: { thread_id: string; attempt: number } })
        .followup;
      const opp = ctx.task.source_ref.match(/^opportunity:([^:]+)/)?.[1];
      const r = await ctx.tools.call("send_email", {
        thread_id: followup?.thread_id ?? (opp ? `opportunity:${opp}` : `task:${ctx.task.task_id}`),
        attempt: followup?.attempt ?? 1,
        entity_id: brief.entity_id,
        recipients: brief.contact.email ? [brief.contact.email] : [],
        contact_source: brief.contact.source,
        company_type: brief.contact.company_type,
        company_domain: brief.contact.domain,
        subject: draft.subject,
        body: draft.body,
      });
      return { output: r.result };
    }) satisfies RoleImpl,
  },
  gateItem: (s: TaskState) => s.outputs.email_draft,
  applyEdit: (s: TaskState, edited: string) => {
    const d = s.outputs.email_draft as EmailDraft;
    s.outputs.email_draft = { ...d, body: edited, edited_by_archie: true };
  },
};

/** Why an observation matters to them: general, no facts about the company (fake writers only). */
export function whyItMatters(field: string): string {
  if (field === "website_found")
    return "Most customers look a business up online before they get in touch, so without a website they may not find you at all.";
  return field.startsWith("website")
    ? "Most customers look a business up online before they get in touch, so the website is often their first impression."
    : "Businesses at that stage often find a clear, up-to-date website brings in better enquiries.";
}

/** Deterministic fake writer: one brief statement first, why it matters, then the offer. */
export function fakeOutreachWriter(req: ModelRequest): string {
  const { brief, followup_attempt } = JSON.parse(req.user) as {
    brief: CompanyBrief;
    followup_attempt?: number;
  };
  const f = brief.facts[0];
  const name = brief.company_name.replace(/ LIMITED$| LTD$/i, "");
  const observation = f ? `${name} ${f.statement}.` : "";
  const body = followup_attempt
    ? `Hi again,\n\n${observation} ${f ? whyItMatters(f.field) : ""} Happy to show you a few ideas if that's useful.`
    : `Hi there,\n\n${observation} ${f ? whyItMatters(f.field) : ""} I help Manchester businesses with fast, modern websites that bring in enquiries. Would a short call next week be useful?`;
  return JSON.stringify({
    subject: followup_attempt ? "Following up" : `A quick idea for ${name}`,
    body,
    claims: f ? [{ fact_id: f.fact_id, text: f.statement }] : [],
  });
}
