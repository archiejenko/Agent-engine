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
    // AE_SCREENS=docs/screens saves the kit screenshots for the cockpit gate report.
    if (process.env.AE_SCREENS && hash === "/kit") {
      const kind = base === emptyUrl ? "kit-empty" : "kit";
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
