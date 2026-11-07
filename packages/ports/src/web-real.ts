import type { FetchedPage, WebFetcher, WebsiteFinder } from "./web.ts";

/**
 * REAL web adapters (cutover; unit-tested with a fake fetch, not yet run live).
 * - HttpWebFetcher: polite GET with a clear User-Agent, timeout, size cap, robots.txt respected.
 * - DomainGuessFinder: tries likely domains from the company name; a site only counts if it shows
 *   the company's number or name (anchoring is re-checked by website ingestion anyway).
 */
export class HttpWebFetcher implements WebFetcher {
  private readonly robots = new Map<string, string[]>();
  constructor(
    private readonly o: {
      userAgent: string;
      timeoutMs?: number;
      maxBytes?: number;
      fetch?: typeof fetch;
    } = {
      userAgent: "EJTECH-verification-bot/1.0 (+https://ejtech.co.uk/bot)",
    },
  ) {}

  private async disallowed(url: URL): Promise<boolean> {
    const f = this.o.fetch ?? fetch;
    if (!this.robots.has(url.host)) {
      let rules: string[] = [];
      try {
        const r = await f(`${url.protocol}//${url.host}/robots.txt`, {
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
        });
        if (r.ok) {
          let applies = false;
          for (const line of (await r.text()).split("\n")) {
            const [k, ...rest] = line.split(":");
            const v = rest.join(":").trim();
            if (/^user-agent$/i.test(k?.trim() ?? ""))
              applies = v === "*" || this.o.userAgent.toLowerCase().includes(v.toLowerCase());
            else if (applies && /^disallow$/i.test(k?.trim() ?? "") && v) rules.push(v);
          }
        }
      } catch {
        rules = [];
      }
      this.robots.set(url.host, rules);
    }
    return (this.robots.get(url.host) ?? []).some((p) => url.pathname.startsWith(p));
  }

  async fetch(url: string): Promise<FetchedPage> {
    const u = new URL(url);
    const fetched_at = new Date().toISOString();
    if (await this.disallowed(u))
      return { url, status: 403, headers: { "x-blocked-by": "robots.txt" }, body: "", fetched_at };
    const f = this.o.fetch ?? fetch;
    try {
      const r = await f(url, {
        headers: { "user-agent": this.o.userAgent, accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
      const text = (await r.text()).slice(0, this.o.maxBytes ?? 500_000);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { url, status: r.status, headers, body: text, fetched_at };
    } catch {
      return { url, status: 0, headers: {}, body: "", fetched_at };
    }
  }
}

export function candidateDomains(name: string): string[] {
  const base = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|plc|llp|the|co|company|uk|group)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!base.length) return [];
  const joined = base.join("");
  const hyph = base.join("-");
  return [
    ...new Set([
      `${joined}.co.uk`,
      `${hyph}.co.uk`,
      `${joined}.com`,
      `${hyph}.com`,
      `${joined}.uk`,
    ]),
  ];
}

export class DomainGuessFinder implements WebsiteFinder {
  constructor(private readonly fetcher: WebFetcher) {}
  async find(company: {
    entity_id: string;
    name: string;
    postcode: string | null;
  }): Promise<string | null> {
    for (const d of candidateDomains(company.name)) {
      for (const url of [`https://www.${d}/`, `https://${d}/`]) {
        const p = await this.fetcher.fetch(url);
        if (p.status !== 200) continue;
        const text = p.body.toUpperCase();
        if (
          text.includes(company.entity_id) ||
          text.includes(company.name.toUpperCase().replace(/ LIMITED$| LTD$/, ""))
        )
          return url;
      }
    }
    return null;
  }
}
