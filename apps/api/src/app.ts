import {
  loadInfraConfig,
  loadModelsConfig,
  loadProductsConfig,
  loadUniverseConfig,
} from "@ae/config";
import type { Autonomy, Claim } from "@ae/contracts";
import { K, loadBundledPlaybooks, playbookStats, promotePlaybook, setKillSwitch } from "@ae/infra";
import { reviewQueue } from "@ae/opportunity";
import {
  InMemoryQueue,
  type PaymentProvider,
  PaymentsPausedError,
  verifyStripeWebhook,
  WebhookSignatureError,
} from "@ae/ports";
import {
  b64,
  companyCheck,
  HEADERS,
  handleCheckoutCompleted,
  matchesRequirements,
  type PaymentPayload,
  requirementsFor,
  unb64,
  type X402Facilitator,
} from "@ae/products";
import type { Storage } from "@ae/storage";
import { accuracyReport, defaultContext, recordGolden, resolveConflict } from "@ae/verification";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

export const SERVICE_NAME = "agent-engine-api";
export const API_VERSION = "0.2.0";

export interface AppDeps {
  /** Returns the Storage for this request (D1 on Cloudflare, SQLite file locally). */
  storage: (env: unknown) => Storage;
  /** Auth for /api/* (Cloudflare Access in deployment; none locally). */
  auth?: MiddlewareHandler;
  runtime: "node" | "worker";
  /** Where the agent runner is in-process (local), decisions apply immediately; otherwise they're queued. */
  decide?: (
    taskId: string,
    decision: "approve" | "edit" | "reject",
    editedText: string | null,
  ) => Promise<unknown>;
  /** x402 company check. Absent = endpoint disabled. Public (agents can't log in): NOT behind Access. */
  x402?: {
    facilitator: X402Facilitator;
    payTo: string;
    /** Premium tier: re-verify the company live before answering. Returns false if it couldn't. */
    refresh?: (companyNumber: string) => Promise<boolean>;
  };
  /** Card payments for the human report and monitoring. Public endpoints; absent = disabled. */
  payments?: { provider: PaymentProvider; webhookSecret: string; publicBaseUrl: string };
}

const Decision = z.object({ decision: z.enum(["approve", "reject"]) });
const TaskDecision = z
  .object({
    decision: z.enum(["approve", "edit", "reject"]),
    edited_text: z.string().min(1).max(5000).nullable().default(null),
  })
  .refine((d) => d.decision !== "edit" || d.edited_text, {
    message: "an edit needs the edited text",
  });
const OutcomeBody = z.object({
  event: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value_bool: z.boolean().nullable().default(null),
  value_gbp: z.number().nonnegative().nullable().default(null),
  observed_at: z.iso.datetime({ offset: true }).optional(),
});
const GoldenBody = z.object({ values: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.json()) });
const ConflictBody = z.object({
  entity_id: z.string().regex(/^[A-Z0-9]{8}$/),
  field: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: z.json(),
});
const Resolve = z.object({
  entity_id: z
    .string()
    .regex(/^[A-Z0-9]{8}$/)
    .nullable(),
});

const FactsQuery = z.object({
  search: z.string().trim().max(100).optional(),
  field: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  status: z.enum(["verified", "conflict", "stale", "quarantined"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** The shared Hono app. Runtime-specific wiring lives in node.ts and worker.ts. Read-only in Phase 1. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const universe = loadUniverseConfig();
  if (deps.auth) app.use("/api/*", deps.auth);

  app.get("/api/health", async (c) => {
    const storage = deps.storage(c.env);
    const db = await storage.health();
    const body = {
      status: db.ok ? "ok" : "degraded",
      service: SERVICE_NAME,
      version: API_VERSION,
      runtime: deps.runtime,
      time: new Date().toISOString(),
      storage: db,
    };
    return c.json(body, db.ok ? 200 : 503);
  });

  app.get("/api/overview", async (c) => {
    const s = deps.storage(c.env);
    const [u, facts, counts, reasons] = await Promise.all([
      s.universe.counts(universe.name),
      s.facts.countByStatus(),
      s.stats.counts(),
      s.stats.universeReasons(universe.name),
    ]);
    return c.json({
      universe: { name: universe.name, region: universe.region.name, ...u, reasons },
      facts,
      counts,
    });
  });

  app.get("/api/facts", async (c) => {
    const q = FactsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_request", issues: q.error.issues }, 400);
    return c.json(await deps.storage(c.env).facts.listCurrent(q.data));
  });

  app.get("/api/companies/:id", async (c) => {
    const id = c.req.param("id").toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(id)) return c.json({ error: "bad_company_number" }, 400);
    const s = deps.storage(c.env);
    const [entity, facts] = await Promise.all([
      s.entities.get(id),
      s.facts.listCurrent({ entityId: id, limit: 200, offset: 0 }),
    ]);
    if (!entity && facts.total === 0) return c.json({ error: "not_found" }, 404);
    // Evidence side by side: every claim behind every fact.
    const ids = [
      ...new Set(facts.rows.flatMap((f) => [...f.supporting_claims, ...f.conflicting_claims])),
    ];
    const claims: Record<string, Claim> = {};
    for (const claimId of ids) {
      const claim = await s.claims.get(claimId);
      if (claim) claims[claimId] = claim;
    }
    return c.json({ entity, facts: facts.rows, claims });
  });

  // ---- Review queue (Phase 2): leads, drafts, conflicts, quarantined matches.
  app.get("/api/review", async (c) => {
    const s = deps.storage(c.env);
    const queue = await reviewQueue(s, 50);
    const names = new Map<string, string>();
    for (const q of queue)
      names.set(q.entity_id, (await s.entities.get(q.entity_id))?.name ?? q.entity_id);
    const drafts = (await s.tasks.list({ status: "awaiting_approval", limit: 100 })).map((t) => ({
      task_id: t.task_id,
      playbook: t.playbook,
      source_ref: t.source_ref,
      cost_gbp: t.cost_gbp,
      awaiting: (t.state as { awaiting?: unknown }).awaiting ?? null,
      brief: (t.state as { outputs?: { company_brief?: unknown } }).outputs?.company_brief ?? null,
      pending_decision: (t.state as { pending_decision?: unknown }).pending_decision ?? null,
    }));
    const conflicts = (await s.facts.listCurrent({ status: "conflict", limit: 50, offset: 0 }))
      .rows;
    const quarantine = await s.quarantine.listOpen(50);
    return c.json({
      opportunities: queue.map((q) => ({ ...q, name: names.get(q.entity_id) })),
      drafts,
      conflicts,
      quarantine,
    });
  });

  app.post("/api/opportunities/:id/decision", async (c) => {
    const body = Decision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const s = deps.storage(c.env);
    const o = await s.opportunities.get(c.req.param("id"));
    if (!o) return c.json({ error: "not_found" }, 404);
    if (o.status !== "proposed") return c.json({ error: "already_decided", status: o.status }, 409);
    await s.opportunities.setStatus(
      o.opportunity_id,
      body.data.decision === "approve" ? "approved" : "rejected",
    );
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/decision", async (c) => {
    const body = TaskDecision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const s = deps.storage(c.env);
    const t = await s.tasks.get(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    if (t.status !== "awaiting_approval") return c.json({ error: "not_awaiting_approval" }, 409);
    if (deps.decide) {
      await deps.decide(t.task_id, body.data.decision, body.data.edited_text);
      return c.json({ ok: true, applied: true });
    }
    await s.tasks.update(t.task_id, {
      state: { ...t.state, pending_decision: { ...body.data, at: new Date().toISOString() } },
    });
    return c.json({ ok: true, applied: false });
  });

  app.get("/api/tasks/:id", async (c) => {
    const s = deps.storage(c.env);
    const t = await s.tasks.get(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    return c.json({
      task: t,
      run_log: await s.runLog.forTask(t.task_id),
      approvals: await s.approvals.forTask(t.task_id),
    });
  });

  app.post("/api/quarantine/:id/resolve", async (c) => {
    const body = Resolve.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    await deps.storage(c.env).quarantine.resolve(c.req.param("id"), body.data.entity_id);
    return c.json({ ok: true });
  });

  // ---- Phase 3: measurement and outcomes.
  const vctx = defaultContext();

  app.get("/api/metrics", async (c) => {
    const s = deps.storage(c.env);
    const day = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const backtests = [];
    for (const m of Object.keys(loadInfraConfig().playbook_for_module))
      backtests.push(await s.backtests.latest(m));
    return c.json({
      verification: await accuracyReport(s, vctx),
      facts: await s.facts.countByStatus(),
      pauses: await s.pauses.active(),
      drift_today: await s.drift.forDay(day),
      backtests: backtests.filter(Boolean),
      margins_7d: await s.margins(since),
      alerts: await s.alerts.list({ unacknowledged: true, limit: 20 }),
    });
  });

  app.get("/api/golden/next", async (c) => {
    const s = deps.storage(c.env);
    const done = new Set((await s.golden.list()).map((g) => g.entity_id));
    const members = (await s.universe.list(universe.name, { included: true, limit: 5000 })).map(
      (m) => m.entity_id,
    );
    const next = members.find((id) => !done.has(id));
    if (!next) return c.json({ entity: null, done: done.size });
    const facts = (
      await s.facts.listCurrent({ entityId: next, limit: 200, offset: 0 })
    ).rows.filter((f) => vctx.verification.golden.fields.includes(f.field));
    return c.json({
      entity: await s.entities.get(next),
      fields: vctx.verification.golden.fields,
      facts,
      done: done.size,
      target: vctx.verification.golden.target_companies,
    });
  });

  app.post("/api/golden/:id", async (c) => {
    const body = GoldenBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const unknown = Object.keys(body.data.values).filter((f) => !vctx.registry.has(f));
    if (unknown.length) return c.json({ error: "unknown_fields", fields: unknown }, 400);
    await recordGolden(
      deps.storage(c.env),
      vctx,
      c.req.param("id").toUpperCase(),
      body.data.values as Record<string, never>,
    );
    return c.json({ ok: true });
  });

  app.post("/api/conflicts/resolve", async (c) => {
    const body = ConflictBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    await resolveConflict(
      deps.storage(c.env),
      vctx,
      body.data.entity_id,
      body.data.field,
      body.data.value as never,
    );
    return c.json({ ok: true });
  });

  app.post("/api/opportunities/:id/outcome", async (c) => {
    const body = OutcomeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const s = deps.storage(c.env);
    const o = await s.opportunities.get(c.req.param("id"));
    if (!o) return c.json({ error: "not_found" }, 404);
    await s.outcomes.add({
      opportunity_id: o.opportunity_id,
      entity_id: o.entity_id,
      module: o.module,
      event: body.data.event,
      value_bool: body.data.value_bool,
      value_gbp: body.data.value_gbp,
      observed_at: body.data.observed_at ?? new Date().toISOString(),
      source: "human",
    });
    return c.json({ ok: true });
  });

  app.post("/api/pauses/resume", async (c) => {
    const body = z
      .object({ source: z.string().min(1), field: z.string().min(1) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    await deps.storage(c.env).pauses.resume(body.data.source, body.data.field);
    return c.json({ ok: true });
  });

  // ---- Phase 4: paid x402 company check (public; payment is the access control).
  app.get("/x402/check/:number", async (c) => {
    const started = Date.now();
    if (!deps.x402) return c.json({ error: "x402_disabled" }, 404);
    const x = deps.x402;
    const cfg = loadProductsConfig().x402;
    const usdToGbp = loadModelsConfig().usd_to_gbp;
    const number = c.req.param("number").toUpperCase();
    const tier = c.req.query("tier") === "premium" ? "premium" : "cached";
    const s = deps.storage(c.env);
    const reqs = requirementsFor(cfg, tier, x.payTo, new URL(c.req.url).pathname);
    const log = (
      status: Parameters<typeof s.x402.log>[0]["status"],
      extra: { payer?: string | null; tx?: string | null; cost?: number } = {},
    ) =>
      s.x402.log({
        id: crypto.randomUUID(),
        company_number: number,
        tier,
        status,
        price_usd: status === "served" ? cfg.prices_usd[tier] : 0,
        price_gbp: status === "served" ? cfg.prices_usd[tier] * usdToGbp : 0,
        cost_gbp: extra.cost ?? 0,
        payer: extra.payer ?? null,
        transaction_ref: extra.tx ?? null,
        network: cfg.network,
        latency_ms: Date.now() - started,
        dry_run: x.facilitator.dryRun,
        task_id: null,
      });
    if (!/^[A-Z0-9]{8}$/.test(number)) return c.json({ error: "bad_company_number" }, 400);
    // Unknown companies are free to ask about: nothing to sell.
    if (
      !(await s.entities.get(number)) &&
      (await s.facts.listCurrent({ entityId: number, limit: 1, offset: 0 })).total === 0
    ) {
      await log("not_found");
      return c.json({ error: "not_found", company_number: number }, 404);
    }
    const header = c.req.header(HEADERS.signature);
    if (!header) {
      await log("challenge");
      const body = {
        x402Version: 2,
        error: "payment required",
        resource: {
          url: c.req.url,
          description: `UK company check (${tier})`,
          mimeType: "application/json",
        },
        accepts: [reqs],
      };
      return c.json(body, 402, { [HEADERS.required]: b64(body) });
    }
    let payload: PaymentPayload;
    try {
      payload = unb64<PaymentPayload>(header);
    } catch {
      await log("invalid_payment");
      return c.json({ error: "invalid payment header" }, 402);
    }
    const mismatch = matchesRequirements(payload, reqs);
    const verified = mismatch
      ? { isValid: false, invalidReason: mismatch }
      : await x.facilitator.verify(payload, reqs);
    if (!verified.isValid) {
      await log("invalid_payment", { payer: verified.payer ?? null });
      return c.json(
        { x402Version: 2, error: verified.invalidReason ?? "invalid payment", accepts: [reqs] },
        402,
      );
    }
    // Do the work first; settle only if it succeeded.
    let refreshed = false;
    if (tier === "premium") {
      refreshed = x.refresh ? await x.refresh(number).catch(() => false) : false;
      if (!refreshed) {
        await log("failed", { payer: verified.payer ?? null });
        return c.json(
          { error: "live re-verification failed; you have not been charged", retry: true },
          503,
        );
      }
    }
    const result = await companyCheck(s, vctx, number, { tier, caller: "x402", refreshed });
    if (!result) {
      await log("failed", { payer: verified.payer ?? null });
      return c.json({ error: "no verified facts; you have not been charged" }, 404);
    }
    const settled = await x.facilitator.settle(payload, reqs);
    if (!settled.success) {
      await log("settle_failed", { payer: verified.payer ?? null });
      return c.json({ error: settled.errorReason ?? "settlement failed" }, 402);
    }
    const priceGbp = cfg.prices_usd[tier] * usdToGbp;
    await s.ledger.record({
      rail: "x402",
      reference: settled.transaction,
      payer: settled.payer ?? null,
      amount_gbp: priceGbp,
      currency_amount: `${reqs.amount} ${cfg.asset}@${cfg.network}`,
      dry_run: x.facilitator.dryRun,
      task_id: null,
    });
    await log("served", {
      payer: settled.payer ?? null,
      tx: settled.transaction,
      cost: cfg.cost_per_call_gbp[tier] + cfg.facilitator_fee_gbp,
    });
    return c.json(result, 200, { [HEADERS.response]: b64(settled) });
  });

  // ---- Phase 5: card payments (public), controls and autonomy (dashboard, behind Access).
  const CheckoutBody = z.object({
    product: z.enum(["human_report", "monitoring_monthly"]),
    company_number: z
      .string()
      .regex(/^[A-Z0-9]{8}$/i)
      .optional(),
    company_numbers: z
      .array(z.string().regex(/^[A-Z0-9]{8}$/i))
      .max(50)
      .optional(),
    email: z.email().optional(),
    webhook_url: z.url().optional(),
  });

  app.post("/public/checkout", async (c) => {
    if (!deps.payments) return c.json({ error: "payments_disabled" }, 404);
    const b = CheckoutBody.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request", issues: b.error.issues }, 400);
    const prices = loadProductsConfig();
    const human = b.data.product === "human_report";
    if (human && !b.data.company_number) return c.json({ error: "company_number required" }, 400);
    if (!human && !b.data.company_numbers?.length)
      return c.json({ error: "company_numbers required" }, 400);
    let session: { id: string; url: string };
    try {
      session = await deps.payments.provider.createCheckout({
        product: b.data.product,
        amount_gbp: human ? prices.human_check.price_gbp : prices.monitoring.monthly_gbp,
        description: human
          ? `UK company check: ${b.data.company_number?.toUpperCase()}`
          : `Company monitoring (${b.data.company_numbers?.length} companies, 1 month)`,
        success_url: `${deps.payments.publicBaseUrl}/thanks`,
        cancel_url: `${deps.payments.publicBaseUrl}/`,
        ...(b.data.email ? { customer_email: b.data.email } : {}),
        metadata: {
          ...(b.data.company_number ? { company_number: b.data.company_number.toUpperCase() } : {}),
          ...(b.data.company_numbers
            ? { company_numbers: b.data.company_numbers.map((x) => x.toUpperCase()).join(",") }
            : {}),
          ...(b.data.webhook_url ? { webhook_url: b.data.webhook_url } : {}),
        },
      });
    } catch (e) {
      if (e instanceof PaymentsPausedError) return c.json({ error: "service_paused" }, 503);
      throw e;
    }
    return c.json({ checkout_url: session.url, session_id: session.id });
  });

  app.post("/webhooks/stripe", async (c) => {
    if (!deps.payments) return c.json({ error: "payments_disabled" }, 404);
    const raw = await c.req.text();
    try {
      const ev = await verifyStripeWebhook(
        raw,
        c.req.header("stripe-signature") ?? null,
        deps.payments.webhookSecret,
      );
      if (!ev) return c.json({ received: true, ignored: true });
      const r = await handleCheckoutCompleted(
        deps.storage(c.env),
        loadInfraConfig(),
        loadProductsConfig(),
        await loadBundledPlaybooks(),
        new InMemoryQueue(),
        ev,
      );
      return c.json({ received: true, ...r });
    } catch (e) {
      if (e instanceof WebhookSignatureError) return c.json({ error: "bad_signature" }, 400);
      throw e;
    }
  });

  app.get("/api/controls", async (c) => {
    const s = deps.storage(c.env);
    const infra = loadInfraConfig();
    const playbooks = await loadBundledPlaybooks();
    const stats = [];
    for (const [name, pb] of playbooks) {
      stats.push({
        ...(await playbookStats(s, name, infra)),
        autonomy: (await s.controls.get<Autonomy>(K.autonomy(name))) ?? pb.spec.autonomy,
        killed: (await s.controls.get<boolean>(K.playbook(name))) ?? false,
      });
    }
    return c.json({
      kill_global: (await s.controls.get<boolean>(K.global)) ?? infra.kill_switch_default_on,
      queue_paused: (await s.controls.get<boolean>(K.queuePaused)) ?? false,
      caps: infra.caps,
      playbooks: stats,
      alerts: await s.alerts.list({ unacknowledged: true, limit: 50 }),
      outbox: await s.outbox.list(20),
    });
  });

  app.post("/api/controls/kill", async (c) => {
    const b = z
      .object({
        scope: z.union([z.literal("global"), z.object({ playbook: z.string().min(1) })]),
        on: z.boolean(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    await setKillSwitch(deps.storage(c.env), b.data.scope, b.data.on, "archie (dashboard)");
    return c.json({ ok: true });
  });

  app.post("/api/controls/queue", async (c) => {
    const b = z.object({ paused: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    await deps.storage(c.env).controls.set(K.queuePaused, b.data.paused, "archie (dashboard)");
    return c.json({ ok: true });
  });

  app.post("/api/playbooks/:name/promote", async (c) => {
    const pb = (await loadBundledPlaybooks()).get(c.req.param("name"));
    if (!pb) return c.json({ error: "not_found" }, 404);
    try {
      return c.json({
        ok: true,
        autonomy: await promotePlaybook(
          deps.storage(c.env),
          pb.spec.playbook,
          pb.spec.autonomy,
          loadInfraConfig(),
          "archie (dashboard)",
        ),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.post("/api/alerts/:id/ack", async (c) => {
    await deps.storage(c.env).alerts.acknowledge(Number(c.req.param("id")));
    return c.json({ ok: true });
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
