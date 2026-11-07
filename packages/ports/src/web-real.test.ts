import { describe, expect, it } from "vitest";
import { candidateDomains, DomainGuessFinder, FakeWebFetcher, HttpWebFetcher } from "./index.ts";

describe("real web adapters (with a fake network)", () => {
  it("respects robots.txt and sends a clear user agent", async () => {
    const seen: string[] = [];
    const f = new HttpWebFetcher({
      userAgent: "EJTECH-bot",
      fetch: (async (u: string, init?: RequestInit) => {
        seen.push(`${u} ${new Headers(init?.headers).get("user-agent") ?? ""}`);
        if (u.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /private");
        return new Response("<p>hi</p>", {
          headers: { "last-modified": "Tue, 01 Jun 2021 10:00:00 GMT" },
        });
      }) as unknown as typeof fetch,
    });
    expect((await f.fetch("https://a.example/private/x")).status).toBe(403);
    const ok = await f.fetch("https://a.example/about");
    expect(ok.status).toBe(200);
    expect(ok.headers["last-modified"]).toMatch(/2021/);
    expect(seen.at(-1)).toBe("https://a.example/about EJTECH-bot");
  });

  it("guesses domains from the name and accepts only a site that names the company", async () => {
    expect(candidateDomains("The Acme Widgets Company Limited")).toEqual([
      "acmewidgets.co.uk",
      "acme-widgets.co.uk",
      "acmewidgets.com",
      "acme-widgets.com",
      "acmewidgets.uk",
    ]);
    const pages = new Map([
      ["https://www.acmewidgets.co.uk/", { body: "Some other business" }],
      ["https://acmewidgets.co.uk/", { body: "Welcome. Company number 01234567" }],
    ]);
    const finder = new DomainGuessFinder(new FakeWebFetcher(pages));
    expect(
      await finder.find({ entity_id: "01234567", name: "ACME WIDGETS LTD", postcode: null }),
    ).toBe("https://acmewidgets.co.uk/");
    expect(
      await finder.find({ entity_id: "07654321", name: "NOBODY HOME LTD", postcode: null }),
    ).toBeNull();
  });
});
