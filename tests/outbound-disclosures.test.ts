import { inflateSync } from "node:zlib";
import { InfraConfig, loadInfraConfig, tradingDisclosure } from "@ae/config";
import { composeEmail, renderDemoHtml, renderLetterPdf, renderPublicPage } from "@ae/infra";
import { alertPayload, renderReport } from "@ae/products";
import { describe, expect, it } from "vitest";

/**
 * Trading disclosures: every letter, email and web page we send or serve must show our registered
 * name, where we're registered, the company number and the registered office (from config).
 */
const cfg = loadInfraConfig();
const legal = cfg.sender.legal;
const parts = [
  legal.registered_name,
  `Registered in ${legal.registered_in}`,
  legal.company_number,
  legal.registered_office,
];
const disclosure = tradingDisclosure(cfg.sender);
const hasAll = (text: string) => parts.every((p) => text.includes(p));

/** Text drawn in a PDF: inflate every content stream and decode pdf-lib's hex-string glyphs. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  let text = "";
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1] as string, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const h of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g))
      text += `${Buffer.from(h[1] as string, "hex").toString("latin1")}\n`;
  }
  return text.replace(/\n/g, " ");
}

describe("trading disclosures on every outbound template", () => {
  it("the disclosure line itself has all four parts", () => {
    expect(hasAll(disclosure)).toBe(true);
  });

  it("outreach email footer", () => {
    expect(hasAll(composeEmail("Hello.", cfg))).toBe(true);
  });

  it("letter PDF footer", async () => {
    const pdf = await renderLetterPdf({
      sender: { name: "Archie", company: "EJTECH Ltd", address: "Manchester, UK", email: "a@x" },
      disclosure,
      recipient: ["The Directors", "ACME LTD"],
      date: "2026-11-09",
      body: "Hello.",
      demoUrl: "https://demo.example.invalid/demo/abc",
      companyName: "ACME",
      optOut: "Stop: email a@x quoting LABC234, or visit demo.example.invalid/stop/LABC234",
      demoDays: 30,
    });
    // The footer may wrap, so compare without line breaks.
    const text = pdfText(pdf).replace(/\s+/g, " ");
    for (const p of parts) expect(text).toContain(p);
  });

  it("demo homepage footer", () => {
    const html = renderDemoHtml({
      companyName: "ACME LTD",
      town: "Manchester",
      sinceYear: "2015",
      sicCodes: ["43210"],
      senderName: "Archie",
      senderCompany: "EJTECH Ltd",
      senderEmail: "a@x",
      disclosure,
    });
    expect(hasAll(html)).toBe(true);
  });

  it("public pages (expired demo, opt-out, not found)", () => {
    expect(hasAll(renderPublicPage("This sample has expired.", disclosure))).toBe(true);
  });

  it("paid report email", () => {
    const html = renderReport(
      {
        company_number: "01234567",
        as_of: "2026-11-09T00:00:00Z",
        fields: {},
        risk_flags: [],
        disclaimer: "x",
      } as never,
      disclosure,
    );
    expect(hasAll(html)).toBe(true);
  });

  it("watch alert payload (email and webhook)", () => {
    const p = alertPayload(
      "01234567",
      { field: "company_status", old_value: "active", new_value: "liquidation" },
      cfg,
    );
    expect(hasAll(p.sent_by)).toBe(true);
  });

  it("config refuses to load without the trading details", () => {
    const bad = structuredClone(cfg) as { sender: Record<string, unknown> };
    delete bad.sender.legal;
    expect(InfraConfig.safeParse(bad).success).toBe(false);
  });
});
