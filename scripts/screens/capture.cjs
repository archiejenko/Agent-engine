// Screenshot record of the whole site (see docs/screens/README in index.html). Headless Chromium.
// Expects: dashboard on :5173 (proxying /api to :8787, the seeded DB, kill switch ON), an API on
// :8788 with an EMPTY database (empty states, via request routing) and an API on :8789 serving a
// COPY of the seeded DB with external actions allowed (public demo pages only exist then).
// Usage: node scripts/screens/capture.cjs <ids.json> <outDir>
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { join } = require("node:path");

const ids = JSON.parse(readFileSync(process.argv[2], "utf8"));
const OUT = require("node:path").resolve(process.argv[3]);
mkdirSync(OUT, { recursive: true });
const DASH = "http://localhost:5173";
const API = "http://localhost:8787";
const EMPTY_API = "http://localhost:8788";
const PUBLIC = "http://localhost:8789";
const WIDTHS = [1440, 390];
const manifest = [];

const shot = (area, page, width, theme) => `${area}-${page}-${width}-${theme}.png`;

async function withPage(browser, width, theme, fn, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  const page = await ctx.newPage();
  if (opts.emptyApi)
    await page.route("**/api/**", async (route) => {
      const u = new URL(route.request().url());
      const res = await fetch(`${EMPTY_API}${u.pathname}${u.search}`, {
        method: route.request().method(),
        headers: { "content-type": "application/json" },
        body: route.request().postData() ?? undefined,
      });
      await route.fulfill({
        status: res.status,
        headers: Object.fromEntries(res.headers),
        body: Buffer.from(await res.arrayBuffer()),
      });
    });
  try {
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
}

async function capture(browser, spec) {
  for (const width of spec.widths ?? WIDTHS)
    for (const theme of spec.themes ?? ["light"]) {
      const file = shot(spec.area, spec.page, width, theme);
      await withPage(
        browser,
        width,
        theme,
        async (page) => {
          await spec.go(page);
          await settle(page);
          if (spec.element) {
            const el = page.locator(spec.element).first();
            await el.screenshot({ path: join(OUT, file) });
          } else await page.screenshot({ path: join(OUT, file), fullPage: true });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          manifest.push({ ...strip(spec), width, theme, file, overflow_px: overflow });
        },
        { emptyApi: spec.emptyApi },
      );
    }
}
const strip = (s) => ({ area: s.area, page: s.page, route: s.route, about: s.about, note: s.note });
const dash = (hash) => async (page) => {
  await page.goto(`${DASH}/#${hash}`);
  // Wait for the page body under the nav (not every page has a heading, e.g. an empty golden set).
  await page.waitForFunction(
    () => {
      const main = document.querySelector("#root main");
      return main && main.children.length > 1 && !/Loading/.test(main.lastElementChild.textContent);
    },
    null,
    { timeout: 20000 },
  );
};

(async () => {
  const browser = await chromium.launch();
  const specs = [
    // Dashboard, seeded data (kill switch ON).
    {
      area: "dashboard",
      page: "overview",
      route: "/#/",
      about:
        "Universe membership (who is in and why), verified facts by status, claim counts and sanity-rule rejections.",
      go: dash("/"),
      themes: ["light", "dark"],
    },
    {
      area: "dashboard",
      page: "facts",
      route: "/#/facts",
      about: "Every verified fact, filterable by company, field and status.",
      go: async (p) => {
        await dash("/facts")(p);
        await p.waitForSelector("table");
      },
    },
    {
      area: "dashboard",
      page: "facts-search",
      route: "/#/facts (search)",
      about: "Searching by company name narrows the facts list.",
      go: async (p) => {
        await dash("/facts")(p);
        await p.fill('input[placeholder="Company name or number"]', "SYNTHETIC TRADING 1");
        await p.waitForTimeout(900);
      },
    },
    {
      area: "dashboard",
      page: "facts-search-empty",
      route: "/#/facts (no match)",
      about: "Empty state: a search that matches nothing.",
      go: async (p) => {
        await dash("/facts")(p);
        await p.fill('input[placeholder="Company name or number"]', "NO SUCH COMPANY ZZZ");
        await p.waitForTimeout(900);
      },
    },
    {
      area: "dashboard",
      page: "company",
      route: `/#/company/${ids.conflict_entity}`,
      about: `One company's facts; the conflicting ${ids.conflict_field} fact is expanded to show each claim, its source and evidence.`,
      go: async (p) => {
        await dash(`/company/${ids.conflict_entity}`)(p);
        await p.waitForSelector("table");
        // The conflicting fact's row (its status cell reads "conflict").
        const row = p.locator("tr", { has: p.locator('td:text-is("conflict")') }).first();
        await row.locator("button").click();
        await p.waitForTimeout(300);
      },
    },
    {
      area: "dashboard",
      page: "company-not-found",
      route: "/#/company/99999999",
      about: "Empty state: a company number we hold nothing for.",
      go: async (p) => {
        await p.goto(`${DASH}/#/company/99999999`);
        await p.waitForTimeout(1500);
      },
    },
    {
      area: "dashboard",
      page: "review-drafts",
      route: "/#/review (Drafts tab)",
      about:
        "Email drafts waiting for approval: the draft, why it matters, and the evidence for its one claim.",
      go: dash("/review"),
    },
    {
      area: "dashboard",
      page: "review-leads",
      route: "/#/review (Leads tab)",
      about:
        "Ranked leads, 20 per page. Each says whether approving makes an email or a letter; score breakdowns are collapsed; x402_discovery is read-only.",
      go: async (p) => {
        await dash("/review")(p);
        await p.click('button[role="tab"]:has-text("Leads")');
        await p.waitForTimeout(300);
      },
    },
    {
      area: "dashboard",
      page: "review-leads-expanded",
      route: "/#/review (Leads tab, first breakdown open)",
      about: "One lead's score breakdown opened: each signal, its weight and the facts behind it.",
      go: async (p) => {
        await dash("/review")(p);
        await p.click('button[role="tab"]:has-text("Leads")');
        await p.locator("details summary").first().click();
        await p.waitForTimeout(300);
      },
    },
    {
      area: "dashboard",
      page: "review-conflicts",
      route: "/#/review (Conflicts tab)",
      about: "Facts whose sources disagree (each links to the company page to compare the claims).",
      go: async (p) => {
        await dash("/review")(p);
        await p.click('button[role="tab"]:has-text("Conflicts")');
        await p.waitForTimeout(300);
      },
    },
    {
      area: "dashboard",
      page: "review-quarantine",
      route: "/#/review (Quarantine tab)",
      about: "Records we couldn't match to a company with confidence, 20 per page.",
      go: async (p) => {
        await dash("/review")(p);
        await p.click('button[role="tab"]:has-text("Quarantine")');
        await p.waitForTimeout(300);
      },
    },
    {
      area: "dashboard",
      page: "letters",
      route: "/#/letters",
      about:
        "Print queue: this week's batch awaiting approval, flags, leave-out boxes, PDF download.",
      go: dash("/letters"),
    },
    {
      area: "dashboard",
      page: "metrics",
      route: "/#/metrics",
      about: "Accuracy and calibration per source/field, drift, backtests, margins.",
      go: dash("/metrics"),
    },
    {
      area: "dashboard",
      page: "golden",
      route: "/#/golden",
      about: "Golden set: companies you've hand-verified, and the next ones to check.",
      go: dash("/golden"),
    },
    {
      area: "dashboard",
      page: "controls",
      route: "/#/controls",
      about: "Kill switches, spend caps, autonomy per playbook, alerts and the outbox.",
      go: dash("/controls"),
    },
  ];
  // Empty states: the same pages against an empty database.
  for (const [page, hash, about] of [
    ["overview", "/", "Overview with no data yet."],
    ["facts", "/facts", "Facts with no data yet."],
    ["review", "/review", "Review queue with nothing waiting (Drafts tab)."],
    ["letters", "/letters", "Letters with no letters or batches."],
    ["metrics", "/metrics", "Metrics with no measurements yet."],
    ["golden", "/golden", "Golden set with nothing verified yet."],
    ["controls", "/controls", "Controls on a fresh install (kill switch ON by default)."],
  ])
    specs.push({
      area: "dashboard",
      page: `${page}-empty`,
      route: `/#${hash} (empty database)`,
      about: `Empty state: ${about}`,
      emptyApi: true,
      go: dash(hash),
    });
  // Public pages.
  specs.push(
    {
      area: "public",
      page: "demo",
      route: `/demo/${ids.live_demo}`,
      about: "The demo homepage a letter's QR code opens (noindex, fixed 'not affiliated' banner).",
      note: "Served from a copy of the database with external actions allowed: with the kill switch ON demo pages return 404 (next shot).",
      go: (p) => p.goto(`${PUBLIC}/demo/${ids.live_demo}`),
      themes: ["light", "dark"],
    },
    {
      area: "public",
      page: "demo-kill-switch-on",
      route: `/demo/${ids.live_demo}`,
      about: "The same demo URL while the kill switch is ON: deliberately not found.",
      go: (p) => p.goto(`${API}/demo/${ids.live_demo}`),
    },
    {
      area: "public",
      page: "demo-expired",
      route: `/demo/${ids.expired_demo}`,
      about: "A demo more than 30 days after its batch was approved.",
      note: "Same database copy, with this demo aged 31 days.",
      go: (p) => p.goto(`${PUBLIC}/demo/${ids.expired_demo}`),
    },
    {
      area: "public",
      page: "opt-out",
      route: `/stop/${ids.opt_out_code}`,
      about: "The short opt-out URL printed on each letter: asks before recording anything.",
      go: (p) => p.goto(`${PUBLIC}/stop/${ids.opt_out_code}`),
    },
    {
      area: "public",
      page: "opt-out-done",
      route: `/stop/${ids.opt_out_code} (after confirming)`,
      about: "After pressing the button: the company is on the suppression list.",
      go: async (p) => {
        await p.goto(`${PUBLIC}/stop/${ids.opt_out_code}`);
        await Promise.all([p.waitForLoadState("load"), p.click("button")]);
        await p.waitForTimeout(500);
      },
    },
    {
      area: "public",
      page: "opt-out-unknown",
      route: "/stop/LZZZZZZ",
      about: "Empty state: an opt-out code we don't recognise.",
      go: (p) => p.goto(`${PUBLIC}/stop/LZZZZZZ`),
    },
  );
  for (const s of specs) {
    process.stdout.write(`${s.area}-${s.page}\n`);
    await capture(browser, s);
  }

  // x402: the decoded PAYMENT-REQUIRED body, formatted.
  const known =
    JSON.parse(execFileSync("curl", ["-s", `${API}/api/facts?limit=1`]).toString()).rows?.[0]
      ?.entity_id ?? ids.conflict_entity;
  const headers = execFileSync("curl", [
    "-s",
    "-D",
    "-",
    "-o",
    "/dev/null",
    `${API}/x402/check/${known}`,
  ]).toString();
  const status = headers.split("\n")[0].trim();
  const pr = headers.split("\n").find((l) => l.toLowerCase().startsWith("payment-required:"));
  const decoded = JSON.parse(Buffer.from(pr.split(":")[1].trim(), "base64").toString("utf8"));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const json = esc(JSON.stringify(decoded, null, 2)).replace(/"([^"]+)":/g, '<b>"$1"</b>:');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:16px;font:14px/1.5 ui-monospace,Menlo,monospace;background:#fff;color:#1b1f24"><div style="font:600 15px system-ui;margin-bottom:8px">GET /x402/check/${known} → ${esc(status)}</div><div style="font:13px system-ui;color:#5b6470;margin-bottom:12px">PAYMENT-REQUIRED header, base64-decoded:</div><pre style="white-space:pre-wrap;word-break:break-all;background:#f6f8fa;border:1px solid #e3e7ec;border-radius:8px;padding:14px;margin:0">${json}</pre></body>`;
  const tmp = join(OUT, "_x402.html");
  writeFileSync(tmp, html);
  for (const width of WIDTHS)
    await withPage(browser, width, "light", async (page) => {
      await page.goto(`file://${tmp}`);
      const file = shot("x402", "payment-required", width, "light");
      await page.screenshot({ path: join(OUT, file), fullPage: true });
      manifest.push({
        area: "x402",
        page: "payment-required",
        route: `/x402/check/${known}`,
        about: "The 402 challenge an AI agent receives: the decoded PAYMENT-REQUIRED body.",
        width,
        theme: "light",
        file,
        overflow_px: 0,
      });
    });
  rmSync(tmp);

  // Letter: page 1 of the pending print batch, rendered to PNG.
  const pdf = join(OUT, "_batch.pdf");
  execFileSync("curl", ["-s", "-o", pdf, `${API}/api/letters/batches/${ids.pending_batch}/pdf`]);
  for (const width of WIDTHS) {
    const base = join(OUT, `letter-print-batch-p1-${width}-light`);
    execFileSync("pdftoppm", [
      "-f",
      "1",
      "-l",
      "1",
      "-singlefile",
      "-scale-to-x",
      String(width),
      "-scale-to-y",
      "-1",
      "-png",
      pdf,
      base,
    ]);
    manifest.push({
      area: "letter",
      page: "print-batch-p1",
      route: `/api/letters/batches/${ids.pending_batch}/pdf (page 1)`,
      about: "Page 1 of the print batch PDF: the letter as it will be printed.",
      width,
      theme: "light",
      file: `letter-print-batch-p1-${width}-light.png`,
      overflow_px: 0,
    });
  }
  rmSync(pdf);
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
  await browser.close();
  console.log(`${manifest.length} screenshots`);
})();
