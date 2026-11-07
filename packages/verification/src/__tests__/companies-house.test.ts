import { loadCompaniesHouseConfig } from "@ae/config";
import { describe, expect, it } from "vitest";
import {
  ChAuthError,
  CompaniesHouseClient,
  fetchCompanyBundle,
} from "../sources/companies-house/client.ts";
import { mapCompanyBundle } from "../sources/companies-house/mapper.ts";
import { TokenBucket } from "../sources/companies-house/rate-limit.ts";
import { charges, fakeChFetch, filings, officers, profile, psc } from "./fixtures/ch.ts";

const cfg = loadCompaniesHouseConfig();
const RUN = "0b6f7f0e-6b1a-4c55-9a8e-2f5d8f1b9a01";
const FETCHED = "2026-11-07T09:00:00Z";

describe("token bucket rate limiter", () => {
  it("never exceeds capacity per window", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(
      5,
      1000,
      () => t,
      async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    );
    for (let i = 0; i < 15; i++) await bucket.take();
    // 5 immediately, then 10 more at 200ms each: total elapsed 2000ms for 15 requests
    expect(t).toBeGreaterThanOrEqual(2000);
    expect(t).toBeLessThan(2100);
  });

  it("uses 85% of the documented 600 per 5 minutes", () => {
    expect(Math.floor(cfg.rate_limit.requests * cfg.rate_limit.use_share)).toBe(510);
  });
});

function client(
  fetchFn: typeof fetch,
  extra: Partial<ConstructorParameters<typeof CompaniesHouseClient>[0]> = {},
) {
  let t = 0;
  return new CompaniesHouseClient({
    apiKey: "test-key",
    config: cfg,
    fetch: fetchFn,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...extra,
  });
}

describe("Companies House client", () => {
  it("sends the key as HTTP Basic username with a blank password", async () => {
    let auth = "";
    const c = client((async (_u: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({});
    }) as typeof fetch);
    await c.get("/company/01234567");
    expect(auth).toBe(`Basic ${btoa("test-key:")}`);
  });

  it("refuses to start without a key", () => {
    expect(() => client(fakeChFetch(), { apiKey: "" })).toThrow(ChAuthError);
  });

  it("returns null for 404 and throws ChAuthError for 401", async () => {
    expect(
      await client(fakeChFetch({ notFound: new Set(["01234567"]) })).get("/company/01234567"),
    ).toBeNull();
    const c = client((async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    await expect(c.get("/company/01234567")).rejects.toThrow(ChAuthError);
  });

  it("retries 5xx with backoff (and 429 after pausing)", async () => {
    const statuses = [429, 503, 200];
    const c = client((async () => {
      const s = statuses.shift() as number;
      return s === 200 ? Response.json({ ok: true }) : new Response("", { status: s });
    }) as unknown as typeof fetch);
    expect(await c.get("/company/01234567")).toEqual({ ok: true });
    expect(c.calls).toBe(3);
  });

  it("429 pauses until the reset time in the header, then carries on", async () => {
    let t = 1_000_000;
    const sleeps: number[] = [];
    const responses = [
      new Response("", {
        status: 429,
        headers: { "x-ratelimit-remain": "0", "x-ratelimit-reset": String((t + 120_000) / 1000) },
      }),
      Response.json({ ok: true }, { headers: { "x-ratelimit-remain": "599" } }),
    ];
    const c = new CompaniesHouseClient({
      apiKey: "k",
      config: cfg,
      fetch: (async () => responses.shift()) as unknown as typeof fetch,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    expect(await c.get("/company/01234567")).toEqual({ ok: true });
    expect(sleeps).toContain(121_000); // reset in 120s, +1s margin
    expect(c.limiter.pauses).toBe(1);
  });

  it("pauses before calling when the remaining quota hits the reserve", async () => {
    let t = 0;
    const sleeps: number[] = [];
    let n = 0;
    const c = new CompaniesHouseClient({
      apiKey: "k",
      config: cfg,
      fetch: (async () =>
        Response.json(
          { n: n++ },
          { headers: { "x-ratelimit-remain": n === 1 ? "90" : "500", "x-ratelimit-reset": "300" } },
        )) as unknown as typeof fetch,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await c.get("/company/00000001"); // response says 90 left: at the reserve (600 × 15%)
    await c.get("/company/00000002"); // so this one waits for the reset first
    expect(c.limiter.pauses).toBe(1);
    expect(sleeps.some((s) => s >= 300_000)).toBe(true);
  });

  it("gives up after max_retries", async () => {
    const c = client((async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    await expect(c.get("/company/01234567")).rejects.toThrow(/500/);
    expect(c.calls).toBe(cfg.max_retries + 1);
  });

  it("serves repeats from the cache without calling the API", async () => {
    const store = new Map<string, unknown>();
    const cache = {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
    };
    const calls: string[] = [];
    const c = client(fakeChFetch({ calls }), { cache });
    await c.get("/company/01234567");
    await c.get("/company/01234567");
    expect(calls).toHaveLength(1);
    expect(c.cacheHits).toBe(1);
  });

  it("pages through list resources", async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({
      transaction_id: `t${i}`,
      date: "2020-01-01",
    }));
    const c = client((async (u: unknown) => {
      const url = new URL(String(u));
      const start = Number(url.searchParams.get("start_index"));
      return Response.json({ items: all.slice(start, start + 100), total_count: all.length });
    }) as unknown as typeof fetch);
    expect((await c.getAll("/company/01234567/filing-history")).items).toHaveLength(230);
  });

  it("fetches a bundle in 5 calls, skipping charges when the profile has none", async () => {
    const calls: string[] = [];
    const c = client(fakeChFetch({ calls }));
    await fetchCompanyBundle(c, "01234567", cfg);
    expect(calls.map((x) => x.split("?")[0])).toEqual([
      "/company/01234567",
      "/company/01234567/officers",
      "/company/01234567/filing-history",
      "/company/01234567/charges",
      "/company/01234567/persons-with-significant-control",
    ]);
  });
});

describe("mapper: API responses → claims", async () => {
  const bundle = {
    company_number: "01234567",
    fetched_at: FETCHED,
    profile: { ...profile("01234567"), surprise_new_field: 1 },
    officers: officers().items,
    filings: filings().items,
    charges: charges().items,
    psc: psc().items,
  };
  const { claims, stats } = await mapCompanyBundle(bundle, RUN, cfg);
  const byField = (f: string) =>
    claims
      .filter((c) => c.field === f)
      .sort((a, b) => a.published_at.localeCompare(b.published_at));

  it("every claim is anchored, tier 1, open lane, with record evidence", () => {
    expect(claims.length).toBeGreaterThan(15);
    for (const c of claims) {
      expect(c.entity_id).toBe("01234567");
      expect(c.source_tier).toBe(1);
      expect(c.lane).toBe("open");
      expect(c.evidence?.kind).toBe("record");
      expect(c.published_at <= c.fetched_at).toBe(true);
    }
  });

  it("logs unknown source fields instead of guessing", () => {
    expect(stats.dropped_source_fields).toEqual({ "profile.surprise_new_field": 1 });
  });

  it("normalises the postcode and dates facts from the filings that published them", () => {
    expect(byField("registered_office_postcode")[0]?.value).toBe("M1 1AA");
    // No AD01 change filed → office knowable since incorporation.
    expect(byField("registered_office_postcode")[0]?.published_at).toBe("2015-03-02T00:00:00Z");
    expect(byField("accounts_category")[0]).toMatchObject({
      value: "micro-entity",
      published_at: "2025-11-20T00:00:00Z",
    });
    expect(byField("sic_codes")[0]?.published_at).toBe("2026-03-10T00:00:00Z"); // last CS01
    expect(byField("company_status")[0]?.published_at).toBe("2015-03-02T00:00:00Z");
    expect(byField("accounts_overdue")[0]?.published_at).toBe(FETCHED); // live flag: knowable now
  });

  it("officer snapshots use the filing date, not the appointment date", () => {
    const active = byField("officers_active");
    const names = (i: number) =>
      ((active[i]?.value ?? []) as { name: string }[]).map((o) => o.name);
    // History window is 6 years: older changes collapse into the state entering the window.
    expect(active.map((c) => c.published_at)).toEqual([
      "2016-01-20T00:00:00Z", // state entering the window (AP03 filed; appointed 2016-01-10)
      "2024-09-14T00:00:00Z", // AP01 filed (appointed 2024-09-01)
      "2025-02-15T00:00:00Z", // TM02 filed (resigned 2025-02-01)
    ]);
    expect(names(0)).toEqual(["FORMER, Jo", "TESTER, Alex"]);
    expect(names(1)).toEqual(["EXAMPLE, Sam", "FORMER, Jo", "TESTER, Alex"]);
    expect(names(2)).toEqual(["EXAMPLE, Sam", "TESTER, Alex"]);
    const history = byField("officer_appointments");
    const jo = (
      (history[history.length - 1]?.value ?? []) as { name: string; resigned_on: string | null }[]
    ).find((o) => o.name === "FORMER, Jo");
    expect(jo?.resigned_on).toBe("2025-02-01");
  });

  it("charges are knowable from delivery; PSC from incorporation-era filing or fallback", () => {
    expect(byField("charges")[0]).toMatchObject({ published_at: "2025-06-05T00:00:00Z" });
    expect(((byField("charges")[0]?.value ?? []) as { status: string }[])[0]?.status).toBe(
      "outstanding",
    );
    // No PSC01 filing in fixtures for 2016-04-06 → conservative fallback to fetch time, and counted.
    expect(byField("psc_active")[0]?.published_at).toBe(FETCHED);
    expect(stats.published_fallbacks.psc_notified).toBe(1);
  });

  it("is deterministic: same responses, same claim ids", async () => {
    const again = await mapCompanyBundle(bundle, RUN, cfg);
    expect(again.claims.map((c) => c.claim_id)).toEqual(claims.map((c) => c.claim_id));
  });

  it("a missing company produces no claims", async () => {
    expect((await mapCompanyBundle({ ...bundle, profile: null }, RUN, cfg)).claims).toEqual([]);
  });
});
