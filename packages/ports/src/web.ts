/** Web ports. Fetched content is UNTRUSTED data: never instructions (guardrail 4). */
export interface FetchedPage {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  fetched_at: string;
}

export interface WebFetcher {
  fetch(url: string): Promise<FetchedPage>;
}

/** Finds a company's website. Real: search/guessing at cutover; fake: a fixed map. */
export interface WebsiteFinder {
  find(company: {
    entity_id: string;
    name: string;
    postcode: string | null;
  }): Promise<string | null>;
}

export class FakeWebFetcher implements WebFetcher {
  requests: string[] = [];
  constructor(
    private readonly pages: Map<
      string,
      { body: string; headers?: Record<string, string>; status?: number }
    >,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  async fetch(url: string): Promise<FetchedPage> {
    this.requests.push(url);
    const p = this.pages.get(url);
    return {
      url,
      status: p ? (p.status ?? 200) : 404,
      headers: p?.headers ?? {},
      body: p?.body ?? "",
      fetched_at: this.now(),
    };
  }
}

export class FakeWebsiteFinder implements WebsiteFinder {
  constructor(private readonly sites: Map<string, string | null>) {}
  async find(company: { entity_id: string }) {
    return this.sites.get(company.entity_id) ?? null;
  }
}

/**
 * A page's useful text for the extractor: visible text without scripts and styles, and without the
 * parts that are boilerplate on every site (navigation menus, sidebars, forms, inline SVG and iframes,
 * cookie or consent banners). Headers and footers are KEPT: they carry the company number, address and
 * copyright year the extractor looks for.
 */
export function usefulText(html: string): string {
  return htmlToText(
    html
      .replace(/<(nav|aside|form|svg|iframe|template|button|select)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(
        /<(div|section)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:cookie|consent|gdpr)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
        " ",
      ),
  );
}

/** Strip HTML to visible text (scripts/styles removed). Used before any model sees a page. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&copy;/g, "©")
    .replace(/&#169;/g, "©")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .join("\n");
}
