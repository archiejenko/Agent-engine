import type { CompaniesHouseConfig } from "@ae/config";
import { HeaderRateLimiter, TokenBucket } from "./rate-limit.ts";

/**
 * Companies House Public Data API client.
 * ASSUMPTIONS TO VERIFY against current docs before the first live run (docs/sources/companies-house.md):
 *  - auth is HTTP Basic with the API key as username and an empty password;
 *  - the limit is 600 requests per 5 minutes per key; 429 when exceeded;
 *  - X-Ratelimit-Remain / X-Ratelimit-Reset (epoch seconds) are sent on every response.
 * Rate limiting is header-driven: we pause until the reset time when the quota runs low or on 429.
 */
export interface ResponseCache {
  get(key: string): Promise<unknown | undefined>;
  set(key: string, body: unknown): Promise<void>;
}

export class ChAuthError extends Error {}
export class ChHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`Companies House ${status} for ${path}`);
  }
}

export interface ClientOptions {
  apiKey: string;
  config: CompaniesHouseConfig;
  fetch?: typeof fetch;
  cache?: ResponseCache;
  bucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class CompaniesHouseClient {
  readonly limiter: HeaderRateLimiter;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  calls = 0;
  cacheHits = 0;

  constructor(private readonly o: ClientOptions) {
    if (!o.apiKey) throw new ChAuthError("CH_API_KEY is not set (add it to .dev.vars)");
    const rl = o.config.rate_limit;
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const bucket =
      o.bucket ??
      new TokenBucket(
        Math.floor(rl.requests * rl.use_share),
        rl.window_seconds * 1000,
        this.now,
        this.sleep,
      );
    this.limiter = new HeaderRateLimiter(
      bucket,
      // Keep the unused share of the limit (15%) in reserve; pause until reset when we reach it.
      {
        reserve: Math.ceil(rl.requests * (1 - rl.use_share)),
        fallbackWindowMs: rl.window_seconds * 1000,
      },
      this.now,
      this.sleep,
    );
    this.fetchFn = o.fetch ?? fetch;
  }

  private auth() {
    return `Basic ${btoa(`${this.o.apiKey}:`)}`;
  }

  /** GET a path. Returns null for 404 (e.g. a company with no PSC register). */
  async get(path: string): Promise<unknown | null> {
    const cached = await this.o.cache?.get(path);
    if (cached !== undefined) {
      this.cacheHits++;
      return cached;
    }
    let attempt = 0;
    let pauses429 = 0;
    for (;;) {
      await this.limiter.beforeRequest();
      this.calls++;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.o.config.api_base_url}${path}`, {
          headers: { Authorization: this.auth(), Accept: "application/json" },
        });
      } catch (e) {
        if (attempt++ >= this.o.config.max_retries) throw e;
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      this.limiter.observe(res.headers);
      if (res.status === 200) {
        const body = await res.json();
        await this.o.cache?.set(path, body);
        return body;
      }
      if (res.status === 404) {
        await this.o.cache?.set(path, null);
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ChAuthError(`Companies House refused the API key (${res.status})`);
      }
      if (res.status === 429) {
        // Over the limit: pause until the window resets, then carry on. Doesn't use up retries,
        // but a cap stops an endless loop if the server keeps refusing.
        if (++pauses429 > 20) throw new ChHttpError(429, path);
        await this.limiter.on429();
        continue;
      }
      if (res.status >= 500 && attempt < this.o.config.max_retries) {
        attempt++;
        await this.sleep(2 ** attempt * 1000);
        continue;
      }
      throw new ChHttpError(res.status, path);
    }
  }

  /** GET every page of a list resource (items_per_page / start_index), up to max_pages. */
  async getAll(path: string): Promise<{ first: Record<string, unknown> | null; items: unknown[] }> {
    const per = this.o.config.items_per_page;
    const items: unknown[] = [];
    let first: Record<string, unknown> | null = null;
    for (let page = 0; page < this.o.config.max_pages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = (await this.get(
        `${path}${sep}items_per_page=${per}&start_index=${page * per}`,
      )) as Record<string, unknown> | null;
      if (!body) break;
      first ??= body;
      const pageItems = Array.isArray(body.items) ? body.items : [];
      items.push(...pageItems);
      const total = Number(body.total_results ?? body.total_count ?? Number.NaN);
      if (pageItems.length < per || (Number.isFinite(total) && items.length >= total)) break;
    }
    return { first, items };
  }
}

export interface CompanyBundle {
  company_number: string;
  fetched_at: string;
  profile: unknown | null;
  officers: unknown[];
  filings: unknown[];
  charges: unknown[];
  psc: unknown[];
}

/** Everything we pull for one company: ~4-5 calls (charges only if the profile says it has any). */
export async function fetchCompanyBundle(
  client: CompaniesHouseClient,
  companyNumber: string,
  config: CompaniesHouseConfig,
  now: () => string = () => new Date().toISOString(),
): Promise<CompanyBundle> {
  const fetched_at = now();
  const profile = (await client.get(`/company/${companyNumber}`)) as Record<string, unknown> | null;
  if (!profile)
    return {
      company_number: companyNumber,
      fetched_at,
      profile: null,
      officers: [],
      filings: [],
      charges: [],
      psc: [],
    };
  const officers = (await client.getAll(`/company/${companyNumber}/officers`)).items;
  const filings = (await client.getAll(`/company/${companyNumber}/filing-history`)).items;
  const wantCharges = !config.fetch_charges_only_if_flagged || profile.has_charges === true;
  const charges = wantCharges
    ? (await client.getAll(`/company/${companyNumber}/charges`)).items
    : [];
  const psc = (await client.getAll(`/company/${companyNumber}/persons-with-significant-control`))
    .items;
  return { company_number: companyNumber, fetched_at, profile, officers, filings, charges, psc };
}
