import { loadUniverseConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
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
}

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

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
