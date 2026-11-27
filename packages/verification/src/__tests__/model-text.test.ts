import { loadVerificationConfig } from "@ae/config";
import { usefulText } from "@ae/ports";
import { describe, expect, it } from "vitest";
import { estimateTokens, pagesForModel } from "../sources/website/model-text.ts";

const cfg = loadVerificationConfig().website_extraction;
const para = (i: number) =>
  `<p>Paragraph ${i}: Acme Widgets fits kitchens across Greater Manchester, family run since 2009.</p>`;

describe("per-page text limit for the extractor", () => {
  it("the budget is in config (6,000 tokens a page, 4 characters a token)", () => {
    expect(cfg).toEqual({ page_token_budget: 6000, chars_per_token: 4 });
  });

  it("strips menus, forms, scripts and cookie banners but keeps the footer", () => {
    const html = `<html><head><script>track()</script><style>p{}</style></head><body>
      <nav><a href="/">Home</a><a href="/about">About</a></nav>
      <div class="cookie-banner">We use cookies <button>Accept</button></div>
      <p>We fit kitchens.</p><form><input name="q"></form>
      <footer>© 2021 Acme Widgets Ltd. Company number 01234567.</footer></body></html>`;
    const t = usefulText(html);
    expect(t).toContain("We fit kitchens.");
    expect(t).toContain("Company number 01234567");
    for (const gone of ["track()", "About", "We use cookies", "Accept"])
      expect(t).not.toContain(gone);
  });

  it("a normal page is unchanged: no cut, every useful line kept", () => {
    // ~2,600 tokens: the average page today.
    const html = `<body>${Array.from({ length: 110 }, (_, i) => para(i)).join("")}</body>`;
    const full = usefulText(html);
    expect(estimateTokens(full, cfg.chars_per_token)).toBeGreaterThan(2000);
    const r = pagesForModel([{ url: "https://a.example/", html }], cfg);
    expect(r.cuts).toEqual([]);
    expect(r.pages[0]?.text).toBe(full);
  });

  it("a huge page is cut to the budget, and the cut says how big it was", () => {
    const html = `<body>${Array.from({ length: 5000 }, (_, i) => para(i)).join("")}</body>`;
    const r = pagesForModel([{ url: "https://a.example/", html }], cfg);
    const kept = r.pages[0]?.text ?? "";
    expect(estimateTokens(kept, cfg.chars_per_token)).toBeLessThanOrEqual(cfg.page_token_budget);
    expect(estimateTokens(kept, cfg.chars_per_token)).toBeGreaterThan(cfg.page_token_budget * 0.8);
    expect(r.cuts).toHaveLength(1);
    expect(r.cuts[0]?.original_tokens).toBe(estimateTokens(usefulText(html), cfg.chars_per_token));
    expect(r.cuts[0]?.original_tokens).toBeGreaterThan(cfg.page_token_budget * 10);
    expect(r.cuts[0]?.kept_tokens).toBe(estimateTokens(kept, cfg.chars_per_token));
  });

  it("a line repeated on every page (the same footer) is sent once", () => {
    const footer = "<footer>Acme Widgets Ltd, company number 01234567</footer>";
    const r = pagesForModel(
      [
        { url: "https://a.example/", html: `<p>Home</p>${footer}` },
        { url: "https://a.example/contact", html: `<p>Call us</p>${footer}` },
      ],
      cfg,
    );
    expect(r.pages[0]?.text).toContain("company number 01234567");
    expect(r.pages[1]?.text).toBe("Call us");
  });
});
