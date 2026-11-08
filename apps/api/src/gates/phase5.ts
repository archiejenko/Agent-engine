import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
import { playbookStats } from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import { FakeInbox, FakeStripe } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, ingestClaims, stableUuid } from "@ae/verification";
import { createApp } from "../app.ts";

/**
 * Phase 5 gate (synthetic): recurring watch customer + alert; human report via Stripe; outreach at L1
 * sent under every guardrail (dry run); replies/opt-outs; zero guardrail breaches; kill switch default.
 */
export async function runPhase5Gate(
  storage: Storage,
  root: string,
  o: { count: number; leads: number; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  const model = fakeModel();
  const world = await buildSyntheticWorld(storage, model, { count: o.count, log });
  const inbox = new FakeInbox();
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    inbox,
  });
  const stripe = new FakeStripe("whsec_gate");
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    decide: (t, d, e) => service.decide(t, d, e),
    payments: {
      provider: stripe,
      webhookSecret: "whsec_gate",
      publicBaseUrl: "https://check.example",
    },
  });
  const members = (await storage.universe.list(world.universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const payAndNotify = async (body: unknown) => {
    const r = (await (await post("/public/checkout", body)).json()) as { session_id: string };
    const hook = await stripe.complete(r.session_id, "buyer@customer.example");
    const res = await post("/webhooks/stripe", hook.body, { "stripe-signature": hook.signature });
    return { hook, res: (await res.json()) as Record<string, unknown> };
  };

  // 1. Monitoring customer → watches → a watched fact changes → alert delivered.
  const watched = members.slice(0, 5);
  await payAndNotify({
    product: "monitoring_monthly",
    company_numbers: watched,
    email: "ops@customer.example",
    webhook_url: "https://customer.example/hooks/companies",
  });
  await service.tick(500);
  const now = new Date().toISOString();
  const run = (await storage.runs.start({ kind: "simulated_change" })).run_id;
  const change: Claim = {
    claim_id: await stableUuid([
      "companies_house",
      watched[0] as string,
      "company_status",
      now,
      "liquidation",
    ]),
    entity_id: watched[0] as string,
    raw_entity_ref: { source_id: watched[0] as string, name: null },
    field: "company_status",
    value: "liquidation",
    source: "companies_house",
    source_tier: 1,
    lane: "open",
    method: "api",
    evidence: { kind: "record", ref: "simulated" },
    observed_at: now,
    published_at: now,
    fetched_at: now,
    run_id: run,
  };
  await ingestClaims(storage, world.ctx, { run_id: run, fetched_at: now }, [change]);
  await service.tick(500);
  const watches = await storage.watches.active();
  const alertsSent = (await Promise.all(watches.map((w) => storage.watches.alerts(w.id)))).flat();

  // 2. Human report via Stripe (and a replayed webhook must not double-charge).
  const report = await payAndNotify({
    product: "human_report",
    company_number: members[5],
    email: "buyer@customer.example",
  });
  const replay = await post("/webhooks/stripe", report.hook.body, {
    "stripe-signature": report.hook.signature,
  });
  await service.tick(500);
  const reportTasks = await storage.tasks.list({ playbook: "human_report", limit: 10 });
  const reportMail = (await storage.outbox.list(500)).filter((m) =>
    m.thread_id.startsWith("report:"),
  );

  // 3. Outreach at L1: leads → drafts → Archie approves → operator sends (dry run) under guardrails.
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const leads = await runModule(storage, world.ctx, fw, { asOf: now });
  // Archie approves the top leads we can actually reach (a verified role address on the company's
  // own website), plus the top lead with no website, to show the "no recipient" block working.
  const contacts = await getVerifiedFacts(storage, world.ctx, {
    entities: leads.opportunities.map((x) => x.entity_id),
    fields: ["contact_email"],
    minConfidence: 0,
    asOf: now,
    lanes: ["open"],
    caller: "internal",
  });
  const reachable = new Set(contacts.map((f) => f.entity_id));
  const picked = [
    ...leads.opportunities.filter((x) => reachable.has(x.entity_id)).slice(0, o.leads - 1),
    ...leads.opportunities.filter((x) => !reachable.has(x.entity_id)).slice(0, 1),
  ];
  for (const opp of picked) await storage.opportunities.setStatus(opp.opportunity_id, "approved");
  await service.tick(500);
  const drafts = await storage.tasks.list({
    playbook: "sme_outreach",
    status: "awaiting_approval",
    limit: 500,
  });
  for (const t of drafts) await service.decide(t.task_id, "approve", null);
  const outreach = (await storage.outbox.list(1000)).filter((m) =>
    m.thread_id.startsWith("opportunity:"),
  );
  const sentish = outreach.filter((m) => m.status !== "blocked");
  const infra = loadInfraConfig();
  const allGuarded = sentish.every(
    (m) =>
      m.body.includes(infra.sender.opt_out_text) &&
      m.body.includes(infra.sender.company) &&
      /^(info|hello|enquiries|contact|sales|office)@/.test(m.recipient),
  );

  // 4. A reply that opts out → suppression; follow-ups for that thread cancelled.
  const first = sentish[0];
  if (first)
    inbox.messages.push({
      id: "r1",
      from: first.recipient,
      to: infra.sender.from_email,
      subject: "Re",
      body: "Not interested, please remove me.",
      received_at: new Date().toISOString(),
      in_reply_to: first.id,
    });
  await service.tick(500);
  const suppressed = first ? await storage.suppressions.isSuppressed(first.recipient) : false;

  const breaches = (await storage.alerts.list({ limit: 10_000 })).filter(
    (a) => a.kind === "guardrail_breach",
  ).length;
  const realSends = (await storage.outbox.list(10_000)).filter((m) => m.status === "sent").length;
  const stats = await playbookStats(storage, "sme_outreach", infra);

  const criteria: GateCriterion[] = [
    {
      criterion:
        "First recurring watch customer (monthly, via Stripe) with a change alert delivered",
      status:
        watches.length === watched.length && alertsSent.length >= 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `${await storage.customers.count()} customer, ${watches.length} watches; ${alertsSent.length} alert(s) for the simulated change (${alertsSent.map((a) => `${a.field}: ${JSON.stringify(a.old_value)} → ${JSON.stringify(a.new_value)}`).join("; ")}), delivered as a dry run`,
    },
    {
      criterion: "First recurring watch customer, live",
      status: "live pending",
      evidence: "needs Stripe keys, a real customer and the kill switch off for watch_alert",
    },
    {
      criterion: "Human report via Stripe Checkout",
      status:
        reportTasks.length === 1 &&
        reportTasks[0]?.status === "done" &&
        reportMail.length === 1 &&
        replay.status === 200
          ? "passed (synthetic)"
          : "failed",
      evidence: `1 task (${reportTasks[0]?.status}), revenue £${reportTasks[0]?.revenue_gbp.toFixed(2)}, report emailed (dry run); replayed webhook created no duplicate (${reportTasks.length} task)`,
    },
    {
      criterion: "First outreach send under all guardrails (L1: approved, then sent)",
      status:
        sentish.length > 0 && allGuarded && outreach.some((m) => m.reason === "no recipient")
          ? "passed (synthetic)"
          : "failed",
      evidence: `${drafts.length} drafts approved → ${sentish.length} sent as dry runs, ${outreach.length - sentish.length} blocked by guardrails (${[...new Set(outreach.filter((m) => m.status === "blocked").map((m) => m.reason))].join(", ")}); every send has sender identity + opt-out and goes to a role-based address on the company's own domain; ${realSends} real sends (kill switch ON by default)`,
    },
    {
      criterion: "Opt-out reply → suppression list",
      status: suppressed ? "passed (synthetic)" : "failed",
      evidence: `${first?.recipient ?? "n/a"} suppressed after replying "not interested"`,
    },
    {
      criterion: "Zero guardrail breaches",
      status: breaches === 0 ? "passed (synthetic)" : "failed",
      evidence: `${breaches} breaches across the run; sme_outreach last ${stats.tasks} tasks: success ${(stats.success_rate * 100).toFixed(0)}%, approved without edits ${(stats.approved_without_edit * 100).toFixed(0)}%`,
    },
    {
      criterion: "First outreach send and first customer, live",
      status: "live pending",
      evidence:
        "needs a sending domain + provider key, and the kill switch off (docs/live-cutover.md)",
    },
  ];
  return { criteria, outreach, breaches, alertsSent };
}
