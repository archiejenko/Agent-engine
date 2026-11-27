/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { AgentService, loadPlaybooks, planCard } from "@ae/agent-runner";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../apps/api/src/app.ts";
import { runPhase5Gate } from "../apps/api/src/gates/phase5.ts";
import { markTestWorldLeadsSimulated } from "../apps/api/src/gates/test-world.ts";
import { seedIdeaFixtures } from "../apps/api/src/gates/v3-phase6.ts";

/**
 * Layout guard: every dashboard page, at phone (390px) and desktop (1440px) widths, with seeded data
 * and with an empty database, must have zero sideways scroll. Builds the dashboard and serves it with
 * the real API (synthetic data, kill switch ON, no network).
 */
const ROOT = join(import.meta.dirname, "..");
const DIST = join(ROOT, "apps/dashboard/dist");
// Every page and tab in the v3 navigation (the nav list is checked against App.tsx below).
const PAGES = [
  "/",
  // Home's tabs (cockpit U2): the full decisions queue and Quality (the old collapsed sections).
  "/?tab=queue",
  "/?tab=quality",
  "/ideas",
  "/board",
  "/vault",
  "/vault/ideas",
  "/ideas/I001",
  "/vault/brain%2Ftaxonomy.md",
  "/crm",
  "/crm/facts",
  "/crm/verify",
  "/inbox",
  "/inbox/sent",
  "/inbox/replies",
  "/inbox/drafts",
  "/inbox/letters",
  "/controls",
  "/controls/keys",
  // Hidden (not in the nav): the cockpit component kit, every component on sample and empty data plus
  // every panel query live (cockpit U1).
  "/kit",
];
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

let browser: Browser;
const servers: { close(): void }[] = [];
let seededUrl = "";
let ideaCardId = "";
let planId = "";
let emptyUrl = "";
let companyId = "";

async function start(storage: Storage): Promise<string> {
  const api = createApp({ runtime: "node", storage: () => storage });
  const root = new Hono();
  root.route("/", api);
  root.get("*", (c) => {
    const path = c.req.path === "/" ? "/index.html" : c.req.path;
    const file = join(DIST, path);
    const target = existsSync(file) ? file : join(DIST, "index.html");
    return c.body(readFileSync(target), 200, {
      "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    });
  });
  return new Promise((resolve) => {
    const server = serve(
      { fetch: root.fetch, port: 0, hostname: "127.0.0.1" },
      (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`),
    );
    servers.push(server);
  });
}

beforeAll(async () => {
  execFileSync("pnpm", ["build:dashboard"], { cwd: ROOT, stdio: "pipe" });
  const seeded = await openSqliteStorage(":memory:");
  await runPhase5Gate(seeded, ROOT, { count: 400, leads: 3, letters: 3 });
  // Test data only (U2 answer b): the fake-Companies-House leads are marked simulated.
  await markTestWorldLeadsSimulated(seeded);
  companyId = (await seeded.facts.listCurrent({ limit: 1, offset: 0 })).rows[0]?.entity_id ?? "";
  // Phase 6: idea cards (one with a question answered) and Board tiles, so those pages have real content.
  const seededIdeas = await seedIdeaFixtures(seeded, [
    ...new Set(
      (await seeded.facts.listCurrent({ limit: 200, offset: 0 })).rows.map((f) => f.entity_id),
    ),
  ]);
  ideaCardId = seededIdeas[0]?.card.card_id ?? "";
  // G4: plan the first idea, so the approval card renders with a real graph and sandbox reports.
  const planner = new AgentService({
    storage: seeded,
    playbooks: await loadPlaybooks(join(ROOT, "playbooks")),
    graphEngine: { enabled: true },
  });
  planId = (
    await planCard(
      { service: planner, sandboxStorage: () => openSqliteStorage(":memory:") },
      ideaCardId,
    )
  ).graph_id;
  seededUrl = await start(seeded);
  emptyUrl = await start(await openSqliteStorage(":memory:"));
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function sidewaysScroll(base: string, hash: string, width: number) {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  try {
    await page.goto(`${base}/#${hash}`);
    await page.waitForFunction(
      () => {
        const main = document.querySelector("main.app");
        return (
          main &&
          main.children.length > 1 &&
          !/Loading/.test(main.lastElementChild?.textContent ?? "")
        );
      },
      null,
      { timeout: 20_000 },
    );
    // Cockpit panels load on their own: wait until none is still loading (no-op on other pages).
    await page.waitForFunction(
      () => !document.querySelector('[data-panel-state="loading"]'),
      null,
      {
        timeout: 20_000,
      },
    );
    // Open every collapsed section too (e.g. score breakdowns), so they're measured as well.
    await page.evaluate(() => {
      for (const d of document.querySelectorAll("details")) d.open = true;
    });
    const x = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // AE_SCREENS=docs/screens saves the cockpit screenshots for the gate reports (Home and the kit).
    // AE_SCREENS_TAG (e.g. "before") goes into the file name.
    const shot = {
      "/": "home",
      "/kit": "kit",
      "/ideas": "ideas",
      "/board": "board",
      "/crm": "crm",
      "/inbox": "inbox",
      "/controls": "controls",
      "/vault": "vault",
    }[hash];
    if (process.env.AE_SCREENS && shot) {
      const tag = process.env.AE_SCREENS_TAG ? `-${process.env.AE_SCREENS_TAG}` : "";
      const kind = `${shot}${tag}${base === emptyUrl ? "-empty" : ""}`;
      await page.screenshot({
        path: join(ROOT, process.env.AE_SCREENS, `dashboard-${kind}-${width}-light.png`),
        fullPage: true,
      });
    }
    return x;
  } finally {
    await page.close();
  }
}

describe("no sideways scroll on any page", () => {
  it("covers every page in the navigation", () => {
    const app = readFileSync(join(ROOT, "apps/dashboard/src/App.tsx"), "utf8");
    const nav = [...app.matchAll(/\["(\/[a-z]*)", "[A-Za-z ]+"\]/g)].map((m) => m[1]);
    expect(nav.length).toBe(7);
    for (const p of nav) expect(PAGES).toContain(p);
  });

  it("the measurement catches overflow (negative control)", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(`${seededUrl}/#/`);
    await page.waitForSelector("main.app nav");
    await page.evaluate(() => {
      const wide = document.createElement("div");
      wide.style.width = "2000px";
      wide.textContent = "too wide";
      document.querySelector("main.app")?.appendChild(wide);
    });
    const x = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await page.close();
    expect(x).toBeGreaterThan(1000);
  });

  it("the plan approval card shows every field in the Dashboard list", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    await page.goto(`${seededUrl}/#/plans/${planId}`);
    await page.waitForSelector("svg[aria-label='Plan graph']");
    const text = (await page.evaluate(() => document.body.textContent)) ?? "";
    await page.close();
    // graph, goal, success metric, stop conditions, budget beside expected value and worst case, autonomy,
    // sandbox per node and scenario with guardrail hits, probes, diff, the note, and the three actions.
    for (const want of [
      "Goal",
      "Success metric",
      "Stop conditions",
      "Budget",
      "worst case",
      "Expected value",
      "Autonomy",
      "Sandbox",
      "guardrail hits",
      "Probes",
      "Changes since the previous attempt",
      "Sandbox proves mechanics and cost, not demand.",
      "Approve",
      "Edit",
      "Reject",
      "acts externally",
    ])
      expect(text, want).toContain(want);
  }, 60_000);

  for (const width of [390, 1440]) {
    it(`seeded data at ${width}px`, async () => {
      const pages = [
        ...PAGES,
        `/crm/${companyId}`,
        "/crm/99999999",
        `/ideas/${ideaCardId}`,
        `/plans/${planId}`,
      ];
      const over: string[] = [];
      for (const p of pages) {
        const x = await sidewaysScroll(seededUrl, p, width);
        if (x > 0) over.push(`${p}: ${x}px`);
      }
      expect(over).toEqual([]);
    }, 120_000);

    it(`empty database at ${width}px`, async () => {
      const over: string[] = [];
      for (const p of PAGES) {
        const x = await sidewaysScroll(emptyUrl, p, width);
        if (x > 0) over.push(`${p}: ${x}px`);
      }
      expect(over).toEqual([]);
    }, 120_000);
  }
});

/** Panels on Home: the cockpit's frames, by title and state. */
async function homePanels(page: import("playwright").Page) {
  await page.waitForSelector("[data-panel-state]");
  await page.waitForFunction(() => !document.querySelector('[data-panel-state="loading"]'), null, {
    timeout: 20_000,
  });
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".cockpit [data-panel-state]")].map((p) => ({
      title: p.getAttribute("aria-label") ?? "",
      state: p.dataset.panelState ?? "",
    })),
  );
}

describe("Home cockpit (cockpit U2)", () => {
  it("one panel query failing leaves every other Home panel rendered, and Retry recovers it", async () => {
    const layout = JSON.parse(
      readFileSync(join(ROOT, "packages/config/src/layouts/home.json"), "utf8"),
    ) as { sections: { panels: { title: string; query: string }[] }[] };
    const panels = layout.sections.flatMap((s) => s.panels);
    const failing = panels.filter((p) => p.query === "kpis").map((p) => p.title);
    expect(failing.length).toBeGreaterThan(0);

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let broken = true;
    await page.route("**/api/panels/kpis?**", (route) =>
      broken
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: '{"error":"forced failure (test)"}',
          })
        : route.continue(),
    );
    try {
      await page.goto(`${seededUrl}/#/`);
      const seen = await homePanels(page);
      // Every panel in home.json is on the page.
      expect(seen.map((p) => p.title).sort()).toEqual(panels.map((p) => p.title).sort());
      for (const p of seen)
        expect(p.state, p.title).toBe(failing.includes(p.title) ? "error" : "ok");
      const text = (await page.textContent(".cockpit")) ?? "";
      expect(text).toContain("Couldn't load this panel: forced failure (test)");

      broken = false;
      const title = failing[0] as string;
      await page.click(`section[aria-label="${title}"] .panel-error button`);
      await page.waitForSelector(`section[aria-label="${title}"][data-panel-state="ok"]`);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("Needs you shows the top 5 with the open count, and its buttons post only to /api/decisions/:id/decide", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") posts.push(new URL(r.url()).pathname);
    });
    try {
      await page.goto(`${seededUrl}/#/`);
      await homePanels(page);
      const panel = 'section[aria-label="Needs you"]';
      const cards = await page.locator(`${panel} .decision-card`).count();
      const count = Number(await page.textContent(`${panel} .panel-count`));
      expect(cards).toBe(Math.min(5, count));
      // "See all (N)" only when more are open than the panel shows; otherwise "Open" goes there too.
      if (count > 5)
        expect(await page.textContent(`${panel} .panel-drill`)).toContain(`See all (${count})`);
      expect(await page.getAttribute(`${panel} .panel-drill`, "href")).toBe("#/?tab=queue");

      // Choose a non-recommended option on the first row that has buttons.
      const button = page.locator(`${panel} .decision-actions button:not(.primary)`).first();
      await button.click();
      // Some choices reopen a fresh decision for the same item (e.g. "Leave it" on an unmatched
      // record), so the count may not drop; what matters is where the choice was posted.
      await expect
        .poll(() => posts.filter((p) => p.endsWith("/decide")).length, { timeout: 20_000 })
        .toBe(1);
      const approvals = posts.filter((p) => p !== "/api/review-sessions");
      expect(approvals.length).toBe(1);
      expect(approvals[0]).toMatch(/^\/api\/decisions\/[^/]+\/decide$/);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the See all link opens the full queue on Home", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.goto(`${seededUrl}/#/?tab=queue`);
      await page.waitForSelector(".card.decision");
      expect(await page.getAttribute('nav.tabs a[aria-current="page"]', "href")).toBe(
        "#/?tab=queue",
      );
    } finally {
      await page.close();
    }
  }, 60_000);
});

describe("other pages (cockpit U3)", () => {
  /** Per page: the route, the panel query forced to fail, and what else must still render. */
  const PAGES_WITH_PANELS: { route: string; query: string; still: string }[] = [
    { route: "/ideas", query: "ideas_board", still: "select[aria-label='Function']" },
    { route: "/board", query: "board_heatmap", still: ".board" },
    { route: "/crm", query: "crm_pipeline", still: "a[href='/api/crm.csv']" },
    { route: "/inbox", query: "inbox_strip", still: "div.tabs[role='tablist']" },
    {
      route: "/controls",
      query: "runway",
      still: "section[aria-label=\"Today's spend against each cap\"][data-panel-state='ok']",
    },
    { route: "/vault", query: "vault_learned", still: "input[aria-label='Search notes']" },
  ];

  for (const p of PAGES_WITH_PANELS)
    it(`${p.route}: the ${p.query} panel failing leaves the rest of the page working`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.route(`**/api/panels/${p.query}?**`, (r) =>
        r.fulfill({
          status: 500,
          contentType: "application/json",
          body: '{"error":"forced failure (test)"}',
        }),
      );
      try {
        await page.goto(`${seededUrl}/#${p.route}`);
        await page.waitForSelector("[data-panel-state='error']", { timeout: 20_000 });
        const err = await page.textContent("[data-panel-state='error']");
        expect(err).toContain("forced failure (test)");
        await page.waitForSelector(p.still, { timeout: 20_000 });
        // Nothing else on the page is in an error state.
        expect(await page.locator("[data-panel-state='error']").count()).toBe(1);
      } finally {
        await page.close();
      }
    }, 60_000);

  it("the leaderboard is a table on a desktop and one compact card per playbook on a phone", async () => {
    for (const [width, cards, table] of [
      [390, true, false],
      [1440, false, true],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        await page.goto(`${seededUrl}/#/`);
        const sel = 'section[aria-label="Playbook leaderboard"]';
        await page.waitForSelector(`${sel}[data-panel-state="ok"]`, { timeout: 20_000 });
        expect(await page.isVisible(`${sel} .lb-cards`), `${width} cards`).toBe(cards);
        expect(await page.isVisible(`${sel} .lb-table`), `${width} table`).toBe(table);
        // Only active playbooks, plus "Show all (N)".
        const toggle = page.locator(`${sel} .panel-toggle`);
        expect(await toggle.textContent()).toMatch(/^Show all \(\d+\)$/);
      } finally {
        await page.close();
      }
    }
  }, 60_000);

  it("Runway links straight to the top-up form in Controls", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    try {
      await page.goto(`${seededUrl}/#/`);
      const link = page.locator('section[aria-label="Runway"] .panel-drill');
      expect(await link.getAttribute("href")).toBe("#/controls?section=pool");
      await link.click();
      await page.waitForSelector("#pool form");
      expect(await page.isVisible("#pool input[type='number']")).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
