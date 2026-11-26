import type { MiddlewareHandler } from "hono";

/**
 * A short cache for the dashboard's heavy aggregates (data layer plan, step 4): Workers KV on
 * Cloudflare (`CACHE`, created as agent-engine-cache at deploy), nothing locally. 60 seconds is KV's
 * minimum expiry. The live cost tracker, spend caps and Budgets NEVER read it: they read
 * daily_rollups, so money is never a minute stale.
 */
export const CACHE_TTL_SECONDS = 60;

export interface CacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

/** The KV binding, as far as we use it. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, o: { expirationTtl: number }): Promise<void>;
}

export const kvCache = (kv: KvLike): CacheStore => ({
  get: (k) => kv.get(k),
  put: (k, v, ttl) => kv.put(k, v, { expirationTtl: ttl }),
});

/** In memory, with expiry (tests; KV's behaviour without KV). */
export function memoryCache(now: () => number = Date.now): CacheStore & { size(): number } {
  const m = new Map<string, { v: string; until: number }>();
  return {
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.until <= now()) {
        m.delete(k);
        return null;
      }
      return e.v;
    },
    async put(k, v, ttl) {
      m.set(k, { v, until: now() + ttl * 1000 });
    },
    size: () => m.size,
  };
}

/** The routes whose answers may be up to 60 s old: aggregates only, never money caps or budgets. */
export const CACHED_ROUTES = ["/api/home", "/api/economics", "/api/board", "/api/crm"] as const;

/** Caches successful JSON GETs, keyed by path and sorted query (the date range is in the key). */
export function cacheMiddleware(cacheFor: (env: unknown) => CacheStore | null): MiddlewareHandler {
  return async (c, next) => {
    const cache = c.req.method === "GET" ? cacheFor(c.env) : null;
    if (!cache) return next();
    const url = new URL(c.req.url);
    const q = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    const key = `v1:${url.pathname}?${new URLSearchParams(q).toString()}`;
    const hit = await cache.get(key);
    if (hit !== null) {
      c.header("x-cache", "hit");
      return c.body(hit, 200, { "content-type": "application/json; charset=utf-8" });
    }
    await next();
    if (c.res.status === 200 && c.res.headers.get("content-type")?.includes("application/json")) {
      const text = await c.res.clone().text();
      await cache.put(key, text, CACHE_TTL_SECONDS);
      c.res.headers.set("x-cache", "miss");
    }
  };
}
