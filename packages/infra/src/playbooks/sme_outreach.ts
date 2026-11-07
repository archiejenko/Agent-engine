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

export function buildBrief(entityId: string, facts: VerifiedFact[], asOf: Date): CompanyBrief {
  const name = facts.find((f) => f.field === "company_name")?.value;
  const out: BriefFact[] = [];
  for (const f of facts) {
    const s = statementFor(f, asOf);
    if (s) out.push({ fact_id: fid(f), field: f.field, ...s, confidence: f.confidence });
  }
  return {
    entity_id: entityId,
    company_name: typeof name === "string" ? name : entityId,
    facts: out,
  };
}

/** The truth check, in code. Returns reasons for failure (empty = pass). */
export function checkDraft(draft: EmailDraft, brief: CompanyBrief): string[] {
  const reasons: string[] = [];
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
  const bodyWithoutName = draft.body.split(brief.company_name).join(" ");
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
  version: 1,
  system: `You write a short, friendly first email from Archie (a Manchester web designer) to a small business.
Use ONLY statements from the brief, copied word for word, and list each one you use in "claims" with its fact_id.
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
        minConfidence: 0.5,
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
        minConfidence: 0.5,
      });
      const current = buildBrief(brief.entity_id, r.result as VerifiedFact[], new Date());
      const reasons = checkDraft(draft, current);
      return {
        output: { passed: reasons.length === 0, reasons },
        check: { passed: reasons.length === 0, reasons },
      };
    }) satisfies RoleImpl,
  },
  gateItem: (s: TaskState) => s.outputs.email_draft,
  applyEdit: (s: TaskState, edited: string) => {
    const d = s.outputs.email_draft as EmailDraft;
    s.outputs.email_draft = { ...d, body: edited, edited_by_archie: true };
  },
};

/** Deterministic fake writer: uses up to three brief statements verbatim. */
export function fakeOutreachWriter(req: ModelRequest): string {
  const { brief } = JSON.parse(req.user) as { brief: CompanyBrief };
  const picked = brief.facts.slice(0, 3);
  const name = brief.company_name.replace(/ LIMITED$| LTD$/i, "");
  const sentences = picked.map((f) => `I noticed that ${name} ${f.statement}.`);
  const body = `Hi there,\n\n${sentences.join(" ")} I help Manchester businesses with fast, modern websites that bring in enquiries. Would a short call next week be useful?`;
  return JSON.stringify({
    subject: `A quick idea for ${name}`,
    body,
    claims: picked.map((f) => ({ fact_id: f.fact_id, text: f.statement })),
  });
}
