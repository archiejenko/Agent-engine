import type { InfraConfig } from "@ae/config";
import type { VerifiedFact } from "@ae/contracts";
import type { ModelRequest } from "@ae/ports";
import type { LetterFlag, Storage } from "@ae/storage";
import { externalActionsAllowed } from "../controls.ts";
import { mergePdfs, renderDemoHtml, renderLetterPdf } from "../letters/render.ts";
import type { PlaybookImpl, RoleImpl, TaskState } from "../runner.ts";
import type { ToolRegistry } from "../tools.ts";
import {
  BRIEF_FIELDS,
  buildBrief,
  type CompanyBrief,
  checkDraft,
  type EmailDraft,
} from "./sme_outreach.ts";

/**
 * sme_letter v1 (L0): for leads we can't email (no website, or no emailable address). A short,
 * truthful letter to "The Directors" at the registered office, with a QR code to a one-page demo
 * homepage made for them. Same truth check as email. Letters wait at a gate and are approved in a
 * weekly print batch; Archie prints and posts them (no print/post API). Demo pages go live only for
 * approved letters, and only while external actions are allowed for sme_letter.
 */
export const LETTER_FIELDS = [
  ...BRIEF_FIELDS,
  "registered_office_address",
  "registered_office_flags",
];

type Address = Record<string, string>;

export interface LetterBrief {
  brief: CompanyBrief;
  address: Address | null;
  undeliverable: boolean;
  town: string | null;
  since_year: string | null;
}

/** Envelope lines: "The Directors", company, then the registered office as Companies House holds it. */
export function addressLines(companyName: string, a: Address): string[] {
  const line1 = [a.premises, a.address_line_1].filter(Boolean).join(" ");
  return [
    "The Directors",
    companyName,
    a.care_of ? `c/o ${a.care_of}` : null,
    a.po_box ? `PO Box ${a.po_box}` : null,
    line1 || null,
    a.address_line_2 ?? null,
    a.locality ?? null,
    a.region ?? null,
    a.postal_code ?? null,
  ].filter((x): x is string => Boolean(x));
}

/**
 * Known bias: many small companies use their accountant's (or a formation agent's) address as the
 * registered office, so the letter may never reach the directors. Flag, don't block: Archie decides.
 */
export function accountantFlags(a: Address, sharedBy: number, cfg: InfraConfig): LetterFlag[] {
  const flags: LetterFlag[] = [];
  const text = Object.values(a).join(" ").toLowerCase();
  const hit = cfg.letters.accountant_keywords.find((k) => text.includes(k.toLowerCase()));
  if (a.care_of) flags.push({ flag: "accountant_address", detail: `care of ${a.care_of}` });
  else if (hit) flags.push({ flag: "accountant_address", detail: `address mentions "${hit}"` });
  if (sharedBy >= cfg.letters.shared_address_threshold)
    flags.push({
      flag: "accountant_address",
      detail: `${sharedBy} companies share this registered office`,
    });
  return flags;
}

export const LETTER_WRITER_PROMPT = {
  id: "sme_letter_draft",
  version: 1,
  system: `You write a short, friendly letter from Archie (a Manchester web designer) to the directors of a small business.
It goes with a free demo homepage Archie made for them (a QR code is printed below the letter).
Use ONLY statements from the brief, copied word for word, and list each one you use in "claims" with its fact_id.
Do not add any other facts, numbers, dates, names or compliments. No placeholders. Under 140 words.
Do not write the greeting, sign-off, address, QR code text or opt-out line: those are added automatically.
Return JSON: {"subject": string, "body": string, "claims": [{"fact_id": string, "text": string}]}.`,
};

const entityOf = (ref: string) => String(ref.split(":").pop());

async function readBrief(
  ctx: { tools: { call(n: string, a: unknown): Promise<{ result: unknown }> } },
  entityId: string,
): Promise<LetterBrief> {
  const r = await ctx.tools.call("verified_facts", {
    entities: [entityId],
    fields: LETTER_FIELDS,
    minConfidence: 0,
  });
  const facts = r.result as VerifiedFact[];
  const get = (f: string) => facts.find((x) => x.field === f && x.status !== "stale")?.value;
  const address = (get("registered_office_address") as Address | undefined) ?? null;
  const flags = get("registered_office_flags") as { undeliverable?: boolean } | undefined;
  const inc = get("incorporation_date");
  return {
    brief: buildBrief(entityId, facts, new Date()),
    address,
    undeliverable: flags?.undeliverable === true,
    town: address?.locality ?? null,
    since_year: typeof inc === "string" ? inc.slice(0, 4) : null,
  };
}

export const SME_LETTER: PlaybookImpl = {
  roles: {
    research: (async (ctx) => ({
      output: await readBrief(ctx, entityOf(ctx.task.source_ref)),
    })) satisfies RoleImpl,

    draft: (async (ctx) => {
      const lb = ctx.inputs.letter_brief as LetterBrief;
      const req: ModelRequest = {
        prompt_id: LETTER_WRITER_PROMPT.id,
        prompt_version: LETTER_WRITER_PROMPT.version,
        role: "writer",
        system: LETTER_WRITER_PROMPT.system,
        user: JSON.stringify({
          brief: lb.brief,
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
      const lb = ctx.inputs.letter_brief as LetterBrief;
      const draft = ctx.inputs.letter_draft as EmailDraft;
      // Re-read the facts now (they may have changed since research).
      const current = await readBrief(ctx, lb.brief.entity_id);
      const reasons = checkDraft(draft, current.brief);
      if (!current.address) reasons.push("no verified registered office address to write to");
      if (current.undeliverable)
        reasons.push("Companies House marks the registered office as undeliverable");
      return {
        output: { passed: reasons.length === 0, reasons },
        check: { passed: reasons.length === 0, reasons },
      };
    }) satisfies RoleImpl,

    prepare: (async (ctx) => {
      const lb = ctx.inputs.letter_brief as LetterBrief;
      const draft = ctx.inputs.letter_draft as EmailDraft;
      const r = await ctx.tools.call("prepare_letter", {
        entity_id: lb.brief.entity_id,
        company_name: lb.brief.company_name,
        address: lb.address,
        town: lb.town,
        since_year: lb.since_year,
        body: draft.body,
      });
      return { output: r.result };
    }) satisfies RoleImpl,
  },
  gateItem: (s: TaskState) => ({
    letter: s.outputs.letter_draft,
    prepared: s.outputs.print_ready,
  }),
};

/** Deterministic fake writer: up to three brief statements, verbatim. */
export function fakeLetterWriter(req: ModelRequest): string {
  const { brief } = JSON.parse(req.user) as { brief: CompanyBrief };
  const picked = brief.facts.slice(0, 3);
  const name = brief.company_name.replace(/ LIMITED$| LTD$/i, "");
  const sentences = picked.map((f) => `I noticed that ${name} ${f.statement}.`);
  const body = `${sentences.join(" ")} I help Manchester businesses with fast, modern websites that bring in enquiries, so I've made a free demo homepage for ${name} to show what's possible. If you like it, I'd be glad to talk it through.`;
  return JSON.stringify({
    subject: `A demo homepage for ${name}`,
    body,
    claims: picked.map((f) => ({ fact_id: f.fact_id, text: f.statement })),
  });
}

/** Printed opt-out code: "L" + 6 unambiguous characters (matches LETTER_CODE in outreach.ts). */
export const optOutCodeFor = () =>
  `L${[...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 31])
    .join("")}`;

/** The one-line opt-out printed on every letter. */
export function letterOptOutLine(cfg: InfraConfig, code: string) {
  return cfg.sender.letter_opt_out_text
    .replace("{email}", cfg.sender.from_email)
    .replace("{code}", code)
    .replace("{url}", optOutUrl(cfg, code).replace(/^https?:\/\//, ""));
}

export function optOutUrl(cfg: InfraConfig, code: string) {
  return `${cfg.letters.demo_base_url.replace(/\/$/, "")}/stop/${code}`;
}

const slugFor = () =>
  [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31])
    .join("");

const b64 = (u: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Suppression-list key for "no more letters" (the list is shared with email). */
export const letterSuppressionKey = (entityId: string) => `entity:${entityId}`;

export function demoUrl(cfg: InfraConfig, slug: string) {
  return `${cfg.letters.demo_base_url.replace(/\/$/, "")}/demo/${slug}`;
}

/** prepare_letter: renders the demo page (unpublished) and the print-ready PDF. Nothing leaves us. */
export function registerLetterTools(
  registry: ToolRegistry,
  deps: { storage: Storage; cfg: InfraConfig; now?: () => Date },
) {
  registry.register(
    {
      name: "prepare_letter",
      description:
        "Render a demo homepage (unpublished) and a print-ready letter PDF. Internal: nothing is sent or published.",
      allowed_lanes: ["open"],
      external: false,
      serves_customer: false,
      allowed_roles: ["writer"],
      rate_limit_per_min: 120,
      cost_gbp_per_call: 0,
    },
    async (args, { task }) => {
      const a = args as {
        entity_id: string;
        company_name: string;
        address: Address | null;
        town: string | null;
        since_year: string | null;
        body: string;
      };
      if (!a.address) throw new Error("no registered office address");
      // "No more letters": the company is on the suppression list as entity:<company number>.
      if (await deps.storage.suppressions.isSuppressed(letterSuppressionKey(a.entity_id)))
        throw new Error("this company asked not to receive letters (suppression list)");
      const s = deps.cfg.sender;
      const existing = await deps.storage.letters.get(task.task_id);
      const slug = existing?.demo_slug ?? slugFor();
      const code = existing?.opt_out_code || optOutCodeFor();
      await deps.storage.demoPages.put({
        slug,
        entity_id: a.entity_id,
        task_id: task.task_id,
        html: renderDemoHtml({
          companyName: a.company_name,
          town: a.town,
          sinceYear: a.since_year,
          senderName: s.name,
          senderCompany: s.company,
          senderEmail: s.from_email,
        }),
      });
      const recipient = addressLines(a.company_name, a.address);
      const shared = await deps.storage.letters.sharedAddressCount(JSON.stringify(a.address));
      const flags = accountantFlags(a.address, shared, deps.cfg);
      const pdf = await renderLetterPdf({
        sender: { name: s.name, company: s.company, address: s.address, email: s.from_email },
        recipient,
        date: (deps.now?.() ?? new Date()).toISOString().slice(0, 10),
        body: a.body,
        demoUrl: demoUrl(deps.cfg, slug),
        companyName: a.company_name.replace(/\s+(LIMITED|LTD\.?|PLC|LLP)$/i, ""),
        optOut: letterOptOutLine(deps.cfg, code),
        demoDays: deps.cfg.letters.demo_expiry_days,
      });
      await deps.storage.letters.put({
        task_id: task.task_id,
        entity_id: a.entity_id,
        company_name: a.company_name,
        address: recipient,
        demo_slug: slug,
        opt_out_code: code,
        pdf_b64: b64(pdf),
        flags,
      });
      return { result: { demo_slug: slug, opt_out_code: code, pages: 1, flags } };
    },
  );
}

const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
};

/**
 * The weekly print batch: every prepared letter still waiting at the gate. At most one batch per
 * `batch_every_days` (pass force for tests/scripts). Returns null when nothing is due.
 */
export async function createPrintBatch(
  storage: Storage,
  cfg: InfraConfig,
  o: { now?: Date; force?: boolean } = {},
) {
  const now = o.now ?? new Date();
  const latest = await storage.printBatches.latest();
  if (
    !o.force &&
    latest &&
    now.getTime() - Date.parse(latest.created_at) < cfg.letters.batch_every_days * 86_400_000
  )
    return null;
  const waiting = [];
  for (const l of await storage.letters.list({ status: "waiting", limit: 1000 })) {
    const t = await storage.tasks.get(l.task_id);
    if (t?.status === "awaiting_approval") waiting.push(l);
  }
  if (!waiting.length) return null;
  const week = isoWeek(now);
  const id = `${week}-${now.getTime().toString(36)}`;
  await storage.printBatches.create({
    id,
    week,
    letter_count: waiting.length,
    flagged_count: waiting.filter((l) => l.flags.length).length,
  });
  await storage.letters.setStatus(
    waiting.map((l) => l.task_id),
    "batched",
    id,
  );
  await storage.alerts.raise(
    "print_batch",
    `Print batch ${week}: ${waiting.length} letters to approve (${waiting.filter((l) => l.flags.length).length} flagged: registered office may be an accountant's)`,
    { batch_id: id },
  );
  return (await storage.printBatches.get(id)) as NonNullable<
    Awaited<ReturnType<Storage["printBatches"]["get"]>>
  >;
}

/**
 * Archie's decision on a batch. Approve = every letter except `exclude` is approved for printing and
 * its demo page is published (served only while external actions are allowed). Reject = none are.
 * Each task's gate is decided through `decideTask` (in-process runner, or queued for it).
 */
export async function decidePrintBatch(
  storage: Storage,
  cfg: InfraConfig,
  batchId: string,
  decision: "approve" | "reject",
  exclude: string[],
  decideTask: (taskId: string, d: "approve" | "reject") => Promise<unknown>,
) {
  const batch = await storage.printBatches.get(batchId);
  if (!batch) throw new Error("batch not found");
  if (batch.status !== "pending") throw new Error(`batch already ${batch.status}`);
  const letters = await storage.letters.list({ batchId, limit: 1000 });
  const ok = decision === "approve" ? letters.filter((l) => !exclude.includes(l.task_id)) : [];
  const no = letters.filter((l) => !ok.includes(l));
  await storage.letters.setStatus(
    ok.map((l) => l.task_id),
    "approved",
  );
  await storage.letters.setStatus(
    no.map((l) => l.task_id),
    "rejected",
  );
  await storage.demoPages.setPublished(
    ok.map((l) => l.demo_slug),
    true,
  );
  for (const l of ok) await decideTask(l.task_id, "approve");
  for (const l of no) await decideTask(l.task_id, "reject");
  await storage.printBatches.decide(batchId, decision === "approve" ? "approved" : "rejected");
  return {
    approved: ok.length,
    rejected: no.length,
    demo_links_live: await externalActionsAllowed(storage, cfg, "sme_letter"),
  };
}

/** One PDF for the whole batch (approved/pending letters, in order). */
export async function batchPdf(storage: Storage, batchId: string): Promise<Uint8Array> {
  const rows = await storage.letters.pdfsForBatch(batchId);
  return mergePdfs(rows.map((r) => unb64(r.pdf_b64)));
}

/**
 * A demo page is served only if its letter was approved AND external actions are allowed, and only
 * for `demo_expiry_days` after its batch was approved; after that it says the sample has expired.
 */
export async function servableDemo(
  storage: Storage,
  cfg: InfraConfig,
  slug: string,
  now: Date = new Date(),
): Promise<{ state: "live"; html: string } | { state: "expired" } | null> {
  const page = await storage.demoPages.get(slug);
  if (!page?.published || !page.published_at) return null;
  if (!(await externalActionsAllowed(storage, cfg, "sme_letter"))) return null;
  const ageDays = (now.getTime() - Date.parse(page.published_at)) / 86_400_000;
  if (ageDays >= cfg.letters.demo_expiry_days) return { state: "expired" };
  return { state: "live", html: page.html };
}

/** "No more letters" via the short URL or an emailed code: the shared suppression list. */
export async function optOutByCode(storage: Storage, code: string, via: string) {
  const letter = await storage.letters.byOptOutCode(code);
  if (!letter) return null;
  await storage.suppressions.add(letterSuppressionKey(letter.entity_id), `letter opt-out (${via})`);
  return letter;
}
