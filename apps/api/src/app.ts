import { loadUniverseConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
import { reviewQueue } from "@ae/opportunity";
import type { Storage } from "@ae/storage";
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

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
