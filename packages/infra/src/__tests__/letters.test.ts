import { loadInfraConfig } from "@ae/config";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { mergePdfs, renderDemoHtml, renderLetterPdf, toWinAnsi } from "../letters/render.ts";
import { accountantFlags, addressLines, fakeLetterWriter } from "../playbooks/sme_letter.ts";
import { checkDraft } from "../playbooks/sme_outreach.ts";

const cfg = loadInfraConfig();
const content = {
  sender: {
    name: "Archie",
    company: "EJTECH Ltd",
    address: "Manchester, UK",
    email: "a@x.invalid",
  },
  recipient: ["The Directors", "ACME WIDGETS LTD", "1 Synthetic Road", "Manchester", "M1 1AA"],
  date: "2026-11-09",
  body: "I noticed that ACME WIDGETS doesn't seem to have a website yet. I've made a free demo homepage.",
  demoUrl: "https://demo.example.invalid/demo/abc123",
  companyName: "ACME WIDGETS",
  optOut: cfg.sender.letter_opt_out_text,
};

describe("letter PDF", () => {
  it("is one print-ready A4 page, deterministic for the same input", async () => {
    const bytes = await renderLetterPdf(content);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(Buffer.from(await renderLetterPdf(content)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("merges letters into one batch PDF, one page each", async () => {
    const one = await renderLetterPdf(content);
    const merged = await PDFDocument.load(await mergePdfs([one, one, one]));
    expect(merged.getPageCount()).toBe(3);
  });

  it("only uses characters the standard PDF font can print", () => {
    expect(toWinAnsi("“Hi” — it’s £9 → ok")).toBe('"Hi" - it\'s £9  ok');
  });
});

describe("demo homepage", () => {
  const html = renderDemoHtml({
    companyName: "ACME <WIDGETS> LTD",
    town: "Manchester",
    sinceYear: "2015",
    senderName: "Archie",
    senderCompany: "EJTECH Ltd",
    senderEmail: "a@x.invalid",
  });
  it("is noindex and says plainly it's a demo", () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive">');
    expect(html).toMatch(/Demo homepage made for/);
    expect(html).toMatch(/isn't listed on search engines/);
  });
  it("escapes company data and states only verified facts (no invented phone numbers)", () => {
    expect(html).toContain("ACME &lt;WIDGETS&gt;");
    expect(html).not.toContain("<WIDGETS>");
    expect(html).toContain("Based in Manchester · Trading since 2015");
    expect(html).not.toMatch(/\b0\d{3,4}\s?\d{6}\b|\+44/);
  });
});

describe("registered office: accountant-address bias", () => {
  it("flags care-of, accountancy wording and addresses shared by many companies", () => {
    expect(accountantFlags({ address_line_1: "1 High St", postal_code: "M1 1AA" }, 1, cfg)).toEqual(
      [],
    );
    expect(
      accountantFlags({ care_of: "Ledger & Co", address_line_1: "Ledger House" }, 1, cfg)[0]
        ?.detail,
    ).toBe("care of Ledger & Co");
    expect(
      accountantFlags({ address_line_1: "Suite 4, Chartered House" }, 1, cfg)[0]?.detail,
    ).toMatch(/chartered/);
    const shared = accountantFlags({ address_line_1: "1 High St" }, 40, cfg);
    expect(shared[0]?.detail).toBe("40 companies share this registered office");
  });
  it("addresses the envelope to The Directors, keeping care-of", () => {
    expect(
      addressLines("ACME LTD", {
        care_of: "Ledger & Co",
        premises: "Suite 2",
        address_line_1: "Ledger House",
        locality: "Manchester",
        postal_code: "M1 1AA",
        country: "England",
      }),
    ).toEqual([
      "The Directors",
      "ACME LTD",
      "c/o Ledger & Co",
      "Suite 2 Ledger House",
      "Manchester",
      "M1 1AA",
    ]);
  });
});

describe("letter draft truth check", () => {
  it("the fake writer's letter passes the same checker as email", () => {
    const brief = {
      entity_id: "01234567",
      company_name: "ACME WIDGETS LTD",
      facts: [
        {
          fact_id: "01234567/website_found/2026-01-01",
          field: "website_found",
          statement: "doesn't seem to have a website yet",
          key: "website",
          confidence: 0.75,
        },
      ],
      contact: {
        email: null,
        company_type: "ltd",
        domain: null,
        source: "company_website" as const,
      },
    };
    const draft = JSON.parse(
      fakeLetterWriter({
        prompt_id: "sme_letter_draft",
        prompt_version: 1,
        role: "writer",
        system: "",
        user: JSON.stringify({ brief }),
        max_tokens: 1000,
      }),
    );
    expect(checkDraft(draft, brief)).toEqual([]);
    expect(checkDraft({ ...draft, body: `${draft.body} Since 1999.` }, brief)).toContain(
      'unsupported number or date "1999"',
    );
  });
});
