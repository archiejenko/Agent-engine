import type { Storage } from "@ae/storage";
import { Hono, type MiddlewareHandler } from "hono";

export const SERVICE_NAME = "agent-engine-api";
export const API_VERSION = "0.1.0";

export interface AppDeps {
  /** Returns the Storage for this request (D1 on Cloudflare, SQLite file locally). */
  storage: (env: unknown) => Storage;
  /** Auth for /api/* (Cloudflare Access in deployment; none locally). */
  auth?: MiddlewareHandler;
  runtime: "node" | "worker";
}

/** The shared Hono app. Runtime-specific wiring lives in node.ts and worker.ts. */
export function createApp(deps: AppDeps) {
  const app = new Hono();
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

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
