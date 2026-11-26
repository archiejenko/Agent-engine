import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { CACHE_TTL_SECONDS, memoryCache } from "./cache.ts";
import {
  BOOKMARK_COOKIE,
  readBookmarks,
  withBookmarkCookie,
  withD1Sessions,
} from "./d1-sessions.ts";

describe("KV cache for dashboard aggregates (data layer plan, step 4)", () => {
  it("hits within 60 seconds, misses after, and keys on the query", async () => {
    const storage = await openSqliteStorage(":memory:");
    let t = 1_000_000;
    const cache = memoryCache(() => t);
    const app = createApp({ runtime: "node", storage: () => storage, cache: () => cache });
    const first = await app.request("/api/economics?days=30");
    expect(first.headers.get("x-cache")).toBe("miss");
    const again = await app.request("/api/economics?days=30");
    expect(again.headers.get("x-cache")).toBe("hit");
    expect(await again.json()).toEqual(await first.json());
    expect((await app.request("/api/economics?days=7")).headers.get("x-cache")).toBe("miss");
    t += CACHE_TTL_SECONDS * 1000 + 1;
    expect((await app.request("/api/economics?days=30")).headers.get("x-cache")).toBe("miss");
  });

  it("the cost tracker and spend caps (Budgets) never go through the cache", async () => {
    const storage = await openSqliteStorage(":memory:");
    const cache = memoryCache();
    const app = createApp({ runtime: "node", storage: () => storage, cache: () => cache });
    for (let i = 0; i < 2; i++) {
      const r = await app.request("/api/budgets");
      expect(r.status).toBe(200);
      expect(r.headers.get("x-cache")).toBeNull();
    }
    expect(cache.size()).toBe(0);
  });
});

/** A fake D1 binding that records which session each request used. */
function fakeD1(name: string, log: string[]) {
  return {
    withSession(c?: string) {
      log.push(`${name}:${c}`);
      return {
        prepare: () => ({}),
        batch: async () => [],
        getBookmark: () => `${name}-bm-2`,
      };
    },
  };
}

describe("D1 sessions (read replication)", () => {
  const env = (log: string[]) => ({
    DB: fakeD1("DB", log),
    FACTS: fakeD1("FACTS", log),
    TELEMETRY: fakeD1("TELEMETRY", log),
    OTHER: 1,
  });

  it("reads start from the caller's bookmarks; writes go to the primary", async () => {
    const log: string[] = [];
    const marks = btoa(JSON.stringify({ DB: "DB-bm-1", FACTS: "FACTS-bm-1" }));
    withD1Sessions(
      new Request("https://e.test/api/home", {
        headers: { cookie: `x=1; ${BOOKMARK_COOKIE}=${encodeURIComponent(marks)}` },
      }),
      env(log),
    );
    expect(log).toEqual(["DB:DB-bm-1", "FACTS:FACTS-bm-1", "TELEMETRY:first-unconstrained"]);
    log.length = 0;
    withD1Sessions(new Request("https://e.test/api/decisions/x", { method: "POST" }), env(log));
    expect(log).toEqual(["DB:first-primary", "FACTS:first-primary", "TELEMETRY:first-primary"]);
  });

  it("the response carries the new bookmarks back, on dashboard routes only", async () => {
    const log: string[] = [];
    const req = new Request("https://e.test/api/home");
    const s = withD1Sessions(req, env(log));
    expect((s.env as Record<string, unknown>).OTHER).toBe(1);
    const res = withBookmarkCookie(req, new Response("{}"), s.bookmarks());
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    expect(readBookmarks(cookie.split(";")[0] ?? "")).toEqual({
      DB: "DB-bm-2",
      FACTS: "FACTS-bm-2",
      TELEMETRY: "TELEMETRY-bm-2",
    });
    const pub = new Request("https://e.test/x402/check");
    expect(
      withBookmarkCookie(pub, new Response("{}"), s.bookmarks()).headers.get("set-cookie"),
    ).toBeNull();
    expect(readBookmarks("ae_d1=not-base64!!")).toEqual({});
  });
});
