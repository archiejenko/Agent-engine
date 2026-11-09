import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";

/**
 * Print-ready letters and demo homepages. Everything here is deterministic (no model): the letter
 * body comes from the checked draft; the sender identity, opt-out and QR code are added by code.
 */

const A4 = { w: 595.28, h: 841.89 };
const MM = 72 / 25.4;

/** Standard PDF fonts only cover WinAnsi: replace the few characters that would break rendering. */
export function toWinAnsi(s: string): string {
  return s
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\n£€©]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

function drawQr(page: PDFPage, url: string, x: number, y: number, size: number) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if (qr.modules.get(r, c))
        page.drawRectangle({
          x: x + (c + quiet) * cell,
          y: y + size - (r + quiet + 1) * cell,
          width: cell,
          height: cell,
          color: rgb(0, 0, 0),
        });
}

export interface LetterContent {
  sender: { name: string; company: string; address: string; email: string };
  recipient: string[];
  date: string;
  body: string;
  demoUrl: string;
  companyName: string;
  /** How long the demo stays up after the batch is approved. */
  demoDays: number;
  /** One line: how to opt out by email (quoting the code) or via the short URL. */
  optOut: string;
}

/** One A4 page. Recipient block sits where a DL/C5 left-window envelope shows it. */
export async function renderLetterPdf(l: LetterContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(`Letter to ${l.companyName}`));
  doc.setCreator("EJTECH agent engine");
  doc.setProducer("pdf-lib");
  doc.setCreationDate(new Date(`${l.date}T09:00:00Z`));
  doc.setModificationDate(new Date(`${l.date}T09:00:00Z`));
  const page = doc.addPage([A4.w, A4.h]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = 25 * MM;
  const right = A4.w - 20 * MM;
  const width = right - left;
  const text = (s: string, x: number, y: number, size = 10.5, f = font) =>
    page.drawText(toWinAnsi(s), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });

  // Sender, top right.
  let y = A4.h - 20 * MM;
  for (const [i, s] of [
    l.sender.name,
    ...(l.sender.name.includes(l.sender.company) ? [] : [l.sender.company]),
    ...l.sender.address.split(/,\s*/),
    l.sender.email,
  ].entries()) {
    const w = (i === 0 ? bold : font).widthOfTextAtSize(toWinAnsi(s), 9.5);
    text(s, right - w, y, 9.5, i === 0 ? bold : font);
    y -= 12;
  }
  // Recipient (window position: ~20 mm from the left, ~50 mm from the top).
  y = A4.h - 52 * MM;
  for (const s of l.recipient) {
    text(s, 20 * MM, y);
    y -= 13;
  }
  y = A4.h - 95 * MM;
  text(new Date(`${l.date}T12:00:00Z`).toLocaleDateString("en-GB", { dateStyle: "long" }), left, y);
  y -= 26;
  text("Dear Directors,", left, y);
  y -= 20;
  for (const line of wrap(toWinAnsi(l.body), font, 10.5, width)) {
    if (line) text(line, left, y);
    y -= 14.5;
  }
  y -= 6;
  text("Best wishes,", left, y);
  y -= 30;
  text(l.sender.name, left, y, 10.5, bold);

  // QR to the demo, bottom of the page.
  const qrSize = 30 * MM;
  const qrY = 30 * MM;
  drawQr(page, l.demoUrl, left, qrY, qrSize);
  const cap = wrap(
    `Scan to see a free demo homepage I made for ${l.companyName}. It's private (not on Google), stays up for ${l.demoDays} days, and there's nothing to pay or sign up for.`,
    font,
    9.5,
    width - qrSize - 8 * MM,
  );
  let cy = qrY + qrSize - 14;
  for (const s of cap) {
    text(s, left + qrSize + 6 * MM, cy, 9.5);
    cy -= 12.5;
  }
  text(l.demoUrl, left + qrSize + 6 * MM, cy - 4, 8.5);
  // Footer: who's writing and how to opt out.
  // The opt-out line, on its own, above the footer.
  // One line, shrunk to fit the printable width (never wrapped), however long the email/URL.
  const optSize = Math.min(8.5, (8.5 * width) / bold.widthOfTextAtSize(toWinAnsi(l.optOut), 8.5));
  text(l.optOut, left, 24 * MM, optSize, bold);
  const foot = wrap(`${l.sender.company}, ${l.sender.address}.`, font, 7.5, width);
  let fy = 18 * MM;
  for (const s of foot) {
    text(s, left, fy, 7.5);
    fy -= 9.5;
  }
  return doc.save({ useObjectStreams: false });
}

/** Merge letters into one print-ready PDF (one page per letter, in order). */
export async function mergePdfs(pdfs: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setTitle("Print batch");
  for (const bytes of pdfs) {
    const src = await PDFDocument.load(bytes);
    for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
  }
  return out.save({ useObjectStreams: false });
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

export interface DemoContent {
  companyName: string;
  town: string | null;
  sinceYear: string | null;
  senderName: string;
  senderCompany: string;
  senderEmail: string;
}

/**
 * A one-page demo homepage. Only facts we verified (name, town, trading since) — no invented services,
 * reviews or phone numbers. noindex + a clear banner: it's a sample, not their live site.
 */
export function renderDemoHtml(d: DemoContent): string {
  const name = esc(d.companyName.replace(/\s+(LIMITED|LTD\.?|PLC|LLP)$/i, ""));
  const town = d.town ? esc(d.town) : null;
  const facts = [
    town ? `Based in ${town}` : null,
    d.sinceYear ? `Trading since ${esc(d.sinceYear)}` : null,
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${name} — demo homepage</title>
<style>
  :root { --ink: #1b1f24; --muted: #5b6470; --accent: #1f5fbf; --bg: #ffffff; --soft: #f3f5f8; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
  .demo { position: fixed; top: 0; left: 0; right: 0; z-index: 10; background: #fff7d6; color: #5a4500; font-size: 14px; line-height: 1.4; padding: 10px 16px; text-align: center; border-bottom: 1px solid #e8d9a0; }
  body { padding-top: 64px; }
  header, section, footer { padding: 0 16px; }
  .wrap { max-width: 960px; margin: 0 auto; }
  header .wrap { display: flex; justify-content: space-between; align-items: center; padding: 18px 0; }
  .logo { font-weight: 700; font-size: 20px; }
  nav a { color: var(--muted); text-decoration: none; margin-left: 18px; font-size: 15px; }
  .hero { background: var(--soft); }
  .hero .wrap { padding: 72px 0; }
  h1 { font-size: clamp(32px, 6vw, 52px); line-height: 1.1; margin: 0 0 16px; }
  .facts { color: var(--muted); margin: 0 0 28px; }
  .cta { display: inline-block; background: var(--accent); color: #fff; padding: 14px 22px; border-radius: 8px; text-decoration: none; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; padding: 56px 0; }
  .card { border: 1px solid #e3e7ec; border-radius: 10px; padding: 22px; }
  .card h2 { font-size: 18px; margin: 0 0 8px; }
  .card p { margin: 0; color: var(--muted); font-size: 15px; }
  footer .wrap { border-top: 1px solid #e3e7ec; padding: 24px 0 40px; color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
<div class="demo" role="note">Sample prepared by ${esc(d.senderCompany)}, not affiliated with ${esc(d.companyName)}</div>
<header><div class="wrap"><div class="logo">${name}</div><nav><a href="#services">Services</a><a href="#about">About</a><a href="#contact">Contact</a></nav></div></header>
<section class="hero"><div class="wrap">
  <h1>${name}</h1>
  ${facts.length ? `<p class="facts">${facts.join(" · ")}</p>` : ""}
  <a class="cta" href="#contact">Get in touch</a>
</div></section>
<section id="services"><div class="wrap grid">
  <div class="card"><h2>Your services here</h2><p>A clear list of what you do, so visitors know straight away they're in the right place.</p></div>
  <div class="card"><h2>Works on every phone</h2><p>Fast, readable and easy to tap: most visitors arrive on a mobile.</p></div>
  <div class="card" id="about"><h2>Easy to contact</h2><p>One obvious button to call, email or ask for a quote.</p></div>
</div></section>
<footer id="contact"><div class="wrap">Like this? Email ${esc(d.senderEmail)} and I'll turn it into your real website. If you'd rather not hear from me, just say so and I won't get in touch again.</div></footer>
</body>
</html>
`;
}
