import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moneyMaths, sourceFiles, writeUrls } from "./cockpit-static.helpers.ts";

/**
 * Cockpit UI static checks (plan §2 and §6):
 *   1. the browser only formats: no kit or panel file does arithmetic on money fields (rule 4);
 *   2. one decisions path: approvals are posted only to /api/decisions/:id/decide (rule 18).
 */
const ROOT = join(import.meta.dirname, "..");
const DASH = join(ROOT, "apps/dashboard/src");
const KIT = join(DASH, "kit");
const rel = (f: string) => f.slice(DASH.length + 1);
const kitFiles = () =>
  [KIT, join(DASH, "panels")].flatMap((d) => {
    try {
      return sourceFiles(d);
    } catch {
      return [];
    }
  });

describe("the browser only formats money (rule 4)", () => {
  it("the detector catches arithmetic on money fields (negative control)", () => {
    for (const bad of [
      "const net = r.revenue_gbp - r.spend_gbp;",
      "total += row.spend_gbp;",
      "const pct = f.value / f.previous;",
      "const x = Math.round(d.money_at_stake_gbp);",
      "width: `$" + "{(r.cost_gbp / max) * 100}%`",
      "const d = 2 * f.change;",
    ])
      expect(moneyMaths(bad), bad).toHaveLength(1);
    for (const ok of [
      "{money(r.net_gbp as number)}",
      "const label = `$" + "{r.label} - $" + "{money(r.spend_gbp)}`;",
      "if ((r.net_gbp as number) < 0) return null;",
      "const up = f.change > 0;",
      "money(d.money_at_stake_gbp as number, { whole: true })",
    ])
      expect(moneyMaths(ok), ok).toEqual([]);
  });

  it("no file in kit/ (or panels/) adds, subtracts, multiplies or divides a money field", () => {
    const files = kitFiles();
    expect(files.length).toBeGreaterThanOrEqual(12);
    const found = files.flatMap((f) =>
      moneyMaths(readFileSync(f, "utf8")).map((l) => `${rel(f)}: ${l.trim()}`),
    );
    expect(found).toEqual([]);
  });
});

/** The only approval endpoint any new code may post to. */
const DECIDE = "/api/decisions/:x/decide";
/**
 * Writes that are not approvals (settings, notes, imports, acknowledgements, Archie's review minutes,
 * and lowering a spend tier, which is always allowed and spends less).
 */
const NOT_APPROVALS = new Set([
  "/api/controls/kill",
  "/api/controls/queue",
  "/api/alerts/:x/ack",
  "/api/golden/:x",
  "/api/ideas/:x/:x",
  "/api/keys/:x",
  "/api/letters/batches",
  "/api/pauses/resume",
  "/api/vault/ideas/matrix/import",
  "/api/vault/ideas/import",
  "/api/vault/note",
  "/api/review-sessions",
  "/api/playbooks/:x/spend-tier",
  // Opens a decision for something Archie starts himself; it approves nothing. The choice is then
  // recorded by /api/decisions/:id/decide (apps/dashboard/src/decide.ts).
  "/api/decisions/request",
]);
describe("one decisions path (rule 18)", () => {
  const writes = sourceFiles(DASH).flatMap((f) =>
    writeUrls(readFileSync(f, "utf8")).map((url) => ({ file: rel(f), url })),
  );

  it("the scan finds the dashboard's writes (positive control)", () => {
    expect(writes.some((w) => w.url === DECIDE && w.file === "kit/DecisionCard.tsx")).toBe(true);
    expect(writes.some((w) => w.url === DECIDE && w.file === "decide.ts")).toBe(true);
    expect(writes.some((w) => w.url === "/api/vault/note")).toBe(true);
    expect(writes.length).toBeGreaterThan(15);
  });

  it("kit/ and panels/ post only to /api/decisions/:id/decide", () => {
    const kit = writes.filter((w) => w.file.startsWith("kit/") || w.file.startsWith("panels/"));
    expect(kit.length).toBeGreaterThan(0);
    expect(kit.filter((w) => w.url !== DECIDE)).toEqual([]);
  });

  it("no dashboard file posts an approval anywhere else: there is no allow-list", () => {
    const stray = writes.filter((w) => w.url !== DECIDE && !NOT_APPROVALS.has(w.url));
    expect(stray).toEqual([]);
  });

  it("the older approval routes are no longer called from the dashboard (U3)", () => {
    for (const old of [
      "/api/owner-approvals",
      "/api/playbooks/:x/promote",
      "/api/board/:x/action",
      "/api/letters/batches/:x/decision",
    ])
      expect(writes.filter((w) => w.url === old)).toEqual([]);
  });
});
