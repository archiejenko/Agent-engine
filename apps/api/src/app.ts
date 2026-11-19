import {
  loadDecisionsConfig,
  loadInfraConfig,
  loadProductsConfig,
  loadTriggersConfig,
  loadUniverseConfig,
} from "@ae/config";
import type { Autonomy, Claim } from "@ae/contracts";
import {
  blindTask,
  type ContactStatus,
  contactStatus,
  type DecisionDeps,
  DecisionError,
  decideSource,
  entityOfRef,
  feedIsStale,
  K,
  lastOutreachTask,
  liftReport,
  loadBundledPlaybooks,
  outreachRoutes,
  playbookDailyCap,
  playbookStats,
  recordOutcome,
  requestAndDecide,
  setKillSwitch,
  setSpendTier,
  spendTier,
  unitEconomics,
  type WorkflowPort,
  weekStart,
} from "@ae/infra";
import { reviewQueue } from "@ae/opportunity";
import {
  FakeKeyStore,
  InMemoryQueue,
  type KeyStore,
  type PaymentProvider,
  PaymentsPausedError,
  verifyStripeWebhook,
  WebhookSignatureError,
} from "@ae/ports";
import { handleCheckoutCompleted } from "@ae/products";
import type { Storage } from "@ae/storage";
import {
  accuracyReport,
  defaultContext,
  recordGolden,
  resolveConflict,
  resumeSource,
} from "@ae/verification";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { BRAIN_NOTES } from "./brain.generated.ts";
import { claimWebhook, mountClaims } from "./claim-route.ts";
import { type AskQuestion, mountIdeas } from "./ideas-routes.ts";
import { mountLetters } from "./letters-route.ts";
import { mountV3 } from "./v3-routes.ts";
import { mountX402, type X402Deps } from "./x402-route.ts";

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
  x402?: X402Deps;
  /** Card payments for the human report and monitoring. Public endpoints; absent = disabled. */
  payments?: { provider: PaymentProvider; webhookSecret: string; publicBaseUrl: string };
  /** brain/ for the Vault. Node reads it from disk; the Worker uses the deploy-time bundle (default). */
  vault?: () => Promise<{ path: string; body: string }[]>;
  /** v3 Phase 5: where keys are saved and read (Secrets Store on Cloudflare; local env store on Node). */
  keys?: (env: unknown) => KeyStore;
  /** Starting workflows and sending them events (claim fulfilment). Absent = claims disabled. */
  workflows?: (env: unknown) => WorkflowPort;
  /** v3 Phase 6: the planner answers a question on an idea card (in-process locally; queued on Workers). */
  ask?: (env: unknown) => AskQuestion;
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

const ReviewSession = z.object({
  item_type: z.enum(["opportunity", "draft", "print_batch", "conflict", "quarantine", "claim"]),
  item_id: z.string().min(1).max(200),
  task_ids: z.array(z.string().max(100)).max(1000).default([]),
  started_at: z.iso.datetime({ offset: true }),
  decided_at: z.iso.datetime({ offset: true }),
  active_ms: z
    .number()
    .int()
    .min(0)
    .max(4 * 3_600_000),
});
const LedgerBody = z.object({
  event: z.enum(["booking", "paid", "refunded", "churned"]),
  entity_id: z.string().regex(/^[A-Z0-9]{8}$/),
  value_gbp: z.number().nonnegative().nullable().default(null),
  observed_at: z.iso.datetime({ offset: true }).optional(),
  note: z.string().max(500).optional(),
});

/** The shared Hono app. Runtime-specific wiring lives in node.ts and worker.ts. Read-only in Phase 1. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const universe = loadUniverseConfig();
  // v3: every approval goes through the one decisions path (rule 18).
  const decisionDeps = (env: unknown): DecisionDeps => ({
    storage: deps.storage(env),
    cfg: loadInfraConfig(),
    dcfg: loadDecisionsConfig(),
    ...(deps.decide ? { decideTask: deps.decide } : {}),
    ...(deps.workflows ? { workflows: deps.workflows(env) } : {}),
  });
  // biome-ignore lint/suspicious/noExplicitAny: Hono context type is generic across runtimes.
  const accessUser = (c: any): string =>
    c.req.header("cf-access-authenticated-user-email") ?? "archie (local dashboard)";
  const viaDecision = async (
    // biome-ignore lint/suspicious/noExplicitAny: Hono context type is generic across runtimes.
    c: any,
    type: string,
    sourceRef: string,
    option: string,
    payload: { edited_text?: string | null; exclude?: string[] } = {},
  ) => {
    try {
      const x = await decideSource(
        decisionDeps(c.env),
        type,
        sourceRef,
        option,
        accessUser(c),
        payload,
      );
      return c.json(
        { ok: !x.error, applied: true, decision_id: x.id, ...(x.error ? { error: x.error } : {}) },
        x.error ? 409 : 200,
      );
    } catch (e) {
      if (e instanceof DecisionError) return c.json({ error: e.message }, 409);
      throw e;
    }
  };
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

  // "Today" panel on Overview: what's waiting for Archie, and the last 7 days' money.
  app.get("/api/today", async (c) => {
    const s = deps.storage(c.env);
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const waiting = await s.tasks.list({ status: "awaiting_approval", limit: 5000 });
    const pendingBatches = (await s.printBatches.list(50)).filter((b) => b.status === "pending");
    let lettersInBatches = 0;
    for (const b of pendingBatches)
      lettersInBatches += (await s.letters.list({ batchId: b.id })).length;
    const margins = await s.margins(since);
    const revenue = margins.reduce((a, m) => a + m.revenue_gbp, 0);
    const cost = margins.reduce((a, m) => a + m.cost_gbp, 0);
    return c.json({
      drafts_waiting: waiting.filter((t) => t.playbook !== "sme_letter").length,
      letters_awaiting_batch_approval: lettersInBatches,
      letters_waiting_for_next_batch: (await s.letters.list({ status: "waiting" })).length,
      pending_batches: pendingBatches.length,
      open_conflicts: (await s.facts.listCurrent({ status: "conflict", limit: 1, offset: 0 }))
        .total,
      open_alerts: (await s.alerts.list({ unacknowledged: true, limit: 10_000 })).length,
      last_7_days: {
        revenue_gbp: Number(revenue.toFixed(2)),
        cost_gbp: Number(cost.toFixed(2)),
        margin_gbp: Number((revenue - cost).toFixed(2)),
      },
    });
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
    const infra = loadInfraConfig();
    const cooldowns = new Map<string, ContactStatus>();
    for (const q of queue) {
      const st = await contactStatus(s, infra, q.entity_id);
      if (st) cooldowns.set(q.entity_id, st);
    }
    const routes = await outreachRoutes(
      s,
      vctx,
      infra,
      queue.map((q) => q.entity_id),
    );
    const names = new Map<string, string>();
    for (const q of queue)
      names.set(q.entity_id, (await s.entities.get(q.entity_id))?.name ?? q.entity_id);
    // Letters are approved in weekly print batches (Letters page), not one by one here.
    const drafts = (await s.tasks.list({ status: "awaiting_approval", limit: 100 }))
      .filter((t) => t.playbook !== "sme_letter")
      .map((t) => ({
        task_id: t.task_id,
        playbook: t.playbook,
        // Blind review (decision D4): holdout and ranked drafts must look identical, so the reference
        // (which says how the task was created) is reduced to the company number.
        entity_id: entityOfRef(t.source_ref),
        cost_gbp: t.cost_gbp,
        awaiting: (t.state as { awaiting?: unknown }).awaiting ?? null,
        brief:
          (t.state as { outputs?: { company_brief?: unknown } }).outputs?.company_brief ?? null,
        pending_decision: (t.state as { pending_decision?: unknown }).pending_decision ?? null,
      }));
    const conflicts = (await s.facts.listCurrent({ status: "conflict", limit: 50, offset: 0 }))
      .rows;
    const quarantine = await s.quarantine.listOpen(50);
    return c.json({
      opportunities: queue.map((q) => ({
        ...q,
        name: names.get(q.entity_id),
        // email: a verified role address we may write to; letter: everything else (sme_letter).
        route: routes.get(q.entity_id) ?? "letter",
        // Blocked by the per-company contact cooldown? Then there's nothing to approve yet.
        cooldown: cooldowns.get(q.entity_id) ?? null,
        opportunities: q.opportunities.map((o) => ({
          ...o,
          actionable: Boolean(infra.playbook_for_module[o.module]),
        })),
      })),
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
    // Only outreach modules can be approved; others (e.g. x402_discovery) are read-only.
    if (body.data.decision === "approve" && !loadInfraConfig().playbook_for_module[o.module])
      return c.json({ error: "read_only_module", module: o.module }, 409);
    // Through the one decisions path (rule 18).
    return viaDecision(
      c,
      "lead",
      `opportunity:${o.opportunity_id}`,
      body.data.decision === "approve" ? "approve" : "skip",
    );
  });

  app.post("/api/tasks/:id/decision", async (c) => {
    const body = TaskDecision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const s = deps.storage(c.env);
    const t = await s.tasks.get(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    if (t.status !== "awaiting_approval") return c.json({ error: "not_awaiting_approval" }, 409);
    // Through the one decisions path (rule 18).
    return viaDecision(
      c,
      "draft",
      `task:${t.task_id}`,
      body.data.decision === "reject" ? "reject" : "approve",
      {
        edited_text: body.data.decision === "edit" ? body.data.edited_text : null,
      },
    );
  });

  app.get("/api/tasks/:id", async (c) => {
    const s = deps.storage(c.env);
    const t = await s.tasks.get(c.req.param("id"));
    if (!t) return c.json({ error: "not_found" }, 404);
    return c.json({
      task: t.status === "awaiting_approval" ? blindTask(t) : t,
      run_log: await s.runLog.forTask(t.task_id),
      approvals: await s.approvals.forTask(t.task_id),
    });
  });

  app.post("/api/quarantine/:id/resolve", async (c) => {
    const body = Resolve.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    if (body.data.entity_id === null)
      return viaDecision(c, "quarantine", `quarantine:${c.req.param("id")}`, "not_a_match");
    // Linking a record to a company is a data correction (verification), not an approval.
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

  // ---- v2 Phase 1: outcome ledger, lift against the holdout, unit economics, review time.
  // Reports may include simulator rows (?synthetic=1), clearly labelled; learning never does.
  app.get("/api/lift", async (c) => {
    const includeSynthetic = c.req.query("synthetic") === "1";
    return c.json(await liftReport(deps.storage(c.env), { includeSynthetic }));
  });

  app.get("/api/economics", async (c) => {
    const days = Math.min(365, Math.max(1, Number(c.req.query("days") ?? 30) || 30));
    const includeSynthetic = c.req.query("synthetic") === "1";
    return c.json({
      days,
      ...(await unitEconomics(deps.storage(c.env), loadInfraConfig(), {
        since: new Date(Date.now() - days * 86_400_000).toISOString(),
        includeSynthetic,
      })),
    });
  });

  app.get("/api/ledger", async (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
    return c.json({ events: await deps.storage(c.env).outcomeLedger.list({ limit }) });
  });

  // Events that happen outside the system (a booked call, a bank-transfer payment) are entered by hand
  // and attributed to the outreach task that last contacted the company.
  app.post("/api/ledger", async (c) => {
    const body = LedgerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const s = deps.storage(c.env);
    const infra = loadInfraConfig();
    const task = await lastOutreachTask(s, infra, body.data.entity_id);
    const ok = await recordOutcome(s, infra, {
      event: body.data.event,
      entity_id: body.data.entity_id,
      task,
      source: "human",
      dedupe_key: `human:${crypto.randomUUID()}`,
      observed_at: body.data.observed_at,
      value_gbp: body.data.value_gbp,
    });
    return c.json({ ok, attributed_to: task?.task_id ?? null }, 201);
  });

  // The dashboard times each review item (only while the page is visible) for unit economics.
  app.post("/api/review-sessions", async (c) => {
    const body = ReviewSession.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    await deps.storage(c.env).reviewSessions.add({
      id: crypto.randomUUID(),
      ...body.data,
      synthetic: false,
    });
    return c.json({ ok: true }, 201);
  });

  // ---- v2 Phase 2: runtime health (cron, queue, dead letters, workflows, change feed, triggers).
  app.get("/api/runtime", async (c) => {
    const s = deps.storage(c.env);
    const triggers = loadTriggersConfig();
    const beats = await s.runtimeStatus.all();
    const now = Date.now();
    const age = (name: string) => {
      const b = beats.find((x) => x.name === name);
      return b ? Math.round((now - Date.parse(b.at)) / 60_000) : null;
    };
    const feed = beats.find((b) => b.name === "change_feed");
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
    const killed =
      (await s.controls.get<boolean>(K.global)) ?? loadInfraConfig().kill_switch_default_on;
    return c.json({
      kill_switch_on: killed,
      heartbeats: beats
        .filter((b) => b.name !== "poll_cursor")
        .map((b) => ({ ...b, minutes_ago: age(b.name) })),
      change_feed: {
        configured: Boolean((feed?.detail as { configured?: boolean } | null)?.configured),
        polling_fallback_active: feedIsStale(feed, triggers),
      },
      dead_letters: await s.deadLetters.list({ open: true, limit: 20 }),
      uncertain_effects: await s.effects.unresolved(20),
      workflows: {
        counts: await s.workflows.counts(),
        attention: [
          ...(await s.workflows.list({ status: "paused", limit: 10 })),
          ...(await s.workflows.list({ status: "errored", limit: 10 })),
        ],
      },
      triggers_7d: await s.triggerStats.since(weekAgo),
    });
  });

  // A person settles an external action whose outcome was unknown (rule 17): it happened (keep it,
  // never repeat) or it didn't (the step may try once more).
  app.post("/api/effects/resolve", async (c) => {
    const body = z
      .object({ key: z.string().min(1).max(300), happened: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request" }, 400);
    const e = await deps.storage(c.env).effects.get(body.data.key);
    if (!e) return c.json({ error: "not_found" }, 404);
    if (e.status === "done") return c.json({ error: "already_done" }, 409);
    return viaDecision(
      c,
      "uncertain_effect",
      `effect:${e.key}`,
      body.data.happened ? "happened" : "did_not_happen",
    );
  });

  app.post("/api/dead-letters/:id/resolve", async (c) =>
    viaDecision(c, "dead_letter", `dead_letter:${c.req.param("id")}`, "set_aside"),
  );

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
    // Resuming also closes the source's drift alerts (Alerts and Paused sources always agree).
    await resumeSource(deps.storage(c.env), body.data.source, body.data.field);
    return c.json({ ok: true });
  });

  // ---- Phase 4: paid x402 company check (public; payment is the access control).
  mountX402(app, deps.x402, deps.storage, vctx);

  // ---- sme_letter: print queue (dashboard) and demo pages (public, noindex).
  mountLetters(app, deps.storage, deps.decide, decisionDeps);
  const fallbackKeys = new FakeKeyStore();
  mountV3(
    app,
    deps.storage,
    decisionDeps,
    accessUser,
    deps.vault ?? (async () => BRAIN_NOTES),
    deps.keys ?? (() => fallbackKeys),
  );
  mountIdeas(app, deps.storage, decisionDeps, accessUser, deps.ask);
  mountClaims(app, {
    storage: deps.storage,
    ...(deps.payments ? { payments: deps.payments } : {}),
    ...(deps.workflows ? { workflows: deps.workflows } : {}),
    decisions: decisionDeps,
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
      // Subscription events for "claim this site" first; anything else goes to the one-off handler.
      const claimed = await claimWebhook(
        deps.storage(c.env),
        deps.workflows?.(c.env),
        raw,
        c.req.header("stripe-signature") ?? null,
        deps.payments.webhookSecret,
      );
      if (claimed) return c.json({ received: true, ...claimed });
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
      const x = await requestAndDecide(
        decisionDeps(c.env),
        {
          type: "autonomy",
          source_ref: `autonomy:${pb.spec.playbook}`,
          summary: `Promote ${pb.spec.playbook} one autonomy level`,
          option: "promote",
          options: [
            {
              key: "promote",
              label: "Promote",
              effect: "one level up (L3 needs this recorded approval)",
            },
            { key: "keep", label: "Keep", effect: "no change" },
          ],
          context: { base: pb.spec.autonomy },
        },
        accessUser(c),
      );
      if (x.error) return c.json({ error: x.error }, 409);
      return c.json({
        ok: true,
        autonomy: await deps.storage(c.env).controls.get(`autonomy:${pb.spec.playbook}`),
      });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  // ---- v2 Phase 3: hard budgets, spend tiers and owner approvals.
  // Owner approvals are created ONLY here, behind Cloudflare Access (Archie). Agents have no other path
  // to create one (a test checks no other source file calls ownerApprovals.add).
  // Raising a tier or reaching L3: a decision Archie makes in one tap (the one recorded-approval path).
  app.post("/api/owner-approvals", async (c) => {
    const body = z
      .discriminatedUnion("kind", [
        z.object({
          kind: z.literal("spend_tier"),
          playbook: z.string().regex(/^[a-z][a-z0-9_]*$/),
          tier: z.enum(["S1", "S2", "S3"]),
          note: z.string().max(500).optional(),
        }),
        z.object({
          kind: z.literal("autonomy_l3"),
          playbook: z.string().regex(/^[a-z][a-z0-9_]*$/),
          note: z.string().max(500).optional(),
        }),
      ])
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const pb = (await loadBundledPlaybooks()).get(body.data.playbook);
    if (!pb) return c.json({ error: "not_found" }, 404);
    try {
      const x =
        body.data.kind === "spend_tier"
          ? await requestAndDecide(
              decisionDeps(c.env),
              {
                type: "spend_tier",
                source_ref: `spend_tier:${body.data.playbook}:${body.data.tier}`,
                summary: `Raise ${body.data.playbook} to ${body.data.tier}`,
                option: "raise",
                options: [
                  {
                    key: "raise",
                    label: `Raise to ${body.data.tier}`,
                    effect: "a higher daily cap",
                  },
                  { key: "keep", label: "Keep the current tier", effect: "no change" },
                ],
              },
              accessUser(c),
            )
          : await requestAndDecide(
              decisionDeps(c.env),
              {
                type: "autonomy",
                source_ref: `autonomy:${body.data.playbook}`,
                summary: `Promote ${body.data.playbook} (to L3 if it's at L2)`,
                option: "promote",
                options: [
                  { key: "promote", label: "Promote", effect: "one level up" },
                  { key: "keep", label: "Keep", effect: "no change" },
                ],
                context: { base: pb.spec.autonomy },
              },
              accessUser(c),
            );
      if (x.error) return c.json({ error: x.error, approval_id: x.approval_id }, 409);
      return c.json({ ok: true, approval_id: x.approval_id, decision_id: x.id }, 201);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  // Lowering a tier is always allowed (safer) and needs no approval.
  app.post("/api/playbooks/:name/spend-tier", async (c) => {
    const b = z
      .object({ tier: z.enum(["S0", "S1", "S2", "S3"]) })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    try {
      await setSpendTier(deps.storage(c.env), c.req.param("name"), b.data.tier, {
        by: "archie (dashboard)",
      });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });

  app.get("/api/budgets", async (c) => {
    const s = deps.storage(c.env);
    const cfg = loadInfraConfig();
    const now = new Date();
    const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const wk = `${weekStart(now)}T00:00:00.000Z`;
    const ex = cfg.caps.exclude_steps;
    const week = await s.budgetEvents.spendSince(wk);
    const playbooks = [];
    for (const p of [...(await loadBundledPlaybooks()).keys()].sort()) {
      const tier = await spendTier(s, p);
      playbooks.push({
        playbook: p,
        tier,
        cap_gbp: playbookDailyCap(cfg, p, tier),
        spent_today_gbp: await s.runLog.spendSince(day, p, ex),
      });
    }
    return c.json({
      global: {
        cap_gbp: cfg.caps.global_per_day_gbp,
        spent_today_gbp: await s.runLog.spendSince(day, undefined, ex),
      },
      explore: {
        share: cfg.caps.explore_share,
        cap_gbp: cfg.caps.explore_share * cfg.caps.global_per_day_gbp * 7,
        spent_this_week_gbp: week.explore,
      },
      tiers: cfg.caps.spend_tiers,
      playbooks,
      refused_today: await s.budgetEvents.refusedSince(day),
      approvals: await s.ownerApprovals.list(20),
    });
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
