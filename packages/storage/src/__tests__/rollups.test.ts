import { describe, expect, it } from "vitest";
import type { CostEventRow } from "../graph.ts";
import { openSqliteStorage } from "../sqlite.ts";

const ev = (o: Partial<CostEventRow> = {}): CostEventRow => ({
  event_id: crypto.randomUUID(),
  at: "2026-11-26T10:00:00.000Z",
  run_id: null,
  graph_id: null,
  graph_version: null,
  node_id: null,
  task_id: null,
  opportunity_id: null,
  revenue_path: "sme_outreach",
  shape_fingerprint: null,
  mode: "live",
  category: "model",
  unit: "model_call",
  quantity: 1,
  unit_price_gbp: 0.1,
  amount_gbp: 0.1,
  price_table_version: "t",
  synthetic: false,
  dry_run: false,
  playbook: "sme_outreach",
  step_id: "draft",
  ...o,
});
const DAY = "2026-11-26T00:00:00.000Z";

describe("daily_rollups (data layer plan, step 4)", () => {
  it("each rollup equals the sum of its events, slice by slice", async () => {
    const s = await openSqliteStorage(":memory:");
    const events = [
      ev(),
      ev({ amount_gbp: 0.25 }),
      ev({ mode: "sandbox", amount_gbp: 3 }),
      ev({ mode: "planner", amount_gbp: 2 }),
      ev({ synthetic: true, amount_gbp: 5 }),
      ev({ dry_run: true, amount_gbp: 0, category: "tool" }),
      ev({
        playbook: "sme_letter",
        step_id: "print_and_post",
        category: "third_party",
        amount_gbp: 1.2,
      }),
      ev({ at: "2026-11-27T09:00:00.000Z", amount_gbp: 7 }),
    ];
    for (const e of events) await s.costEvents.add(e);
    const rows = await s.dailyRollups.range({ from: "2026-11-26", to: "2026-11-28" });
    for (const r of rows) {
      const mine = events.filter(
        (e) =>
          e.at.slice(0, 10) === r.day &&
          (e.revenue_path ?? "") === r.revenue_path &&
          (e.playbook ?? "") === r.playbook &&
          e.mode === r.mode &&
          e.synthetic === r.synthetic &&
          e.dry_run === r.dry_run,
      );
      expect(r.cost_events).toBe(mine.length);
      expect(r.cost_gbp).toBeCloseTo(
        mine.reduce((a, e) => a + e.amount_gbp, 0),
        12,
      );
    }
    expect(rows.reduce((a, r) => a + r.cost_events, 0)).toBe(events.length);
  });

  it("spend from the rollups matches the events: live, not dry run, steps left out, never sandbox or planner", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.costEvents.add(ev({ amount_gbp: 0.5 }));
    await s.costEvents.add(ev({ mode: "sandbox", amount_gbp: 3 }));
    await s.costEvents.add(ev({ mode: "planner", amount_gbp: 2 }));
    await s.costEvents.add(ev({ dry_run: true, amount_gbp: 9, category: "tool" }));
    await s.costEvents.add(
      ev({
        playbook: "sme_letter",
        step_id: "print_and_post",
        category: "third_party",
        amount_gbp: 1.2,
      }),
    );
    const ex = { excludeSteps: ["print_and_post"] };
    expect(await s.costEvents.spendSince(DAY, ex)).toBeCloseTo(0.5, 12);
    expect(await s.costEvents.spendSince(DAY)).toBeCloseTo(1.7, 12);
    expect(await s.costEvents.spendSince(DAY, { playbook: "sme_letter", ...ex })).toBeCloseTo(
      0,
      12,
    );
    expect(await s.costEvents.spendSince(DAY, { playbook: "sme_letter" })).toBeCloseTo(1.2, 12);
    // A mid-day `since` sums the events themselves: the same answer.
    expect(await s.costEvents.spendSince("2026-11-26T00:00:01.000Z", ex)).toBeCloseTo(0.5, 12);
  });

  it("a failed write records neither the event nor its rollup", async () => {
    const s = await openSqliteStorage(":memory:");
    const e = ev();
    await s.costEvents.add(e);
    await expect(s.costEvents.add(e)).rejects.toThrow(); // same event id: refused
    const rows = await s.dailyRollups.range({ from: "2026-11-26", to: "2026-11-27" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cost_events: 1, cost_gbp: 0.1 });
    expect(await s.costEvents.forRun("none")).toEqual([]);
  });

  it("revenue rolls up too, with Stripe test-mode money as dry run (never live revenue)", async () => {
    const s = await openSqliteStorage(":memory:");
    for (const [reference, test_mode] of [
      ["cs_1", false],
      ["cs_2", true],
    ] as const)
      await s.revenueEvents.add({
        event_id: crypto.randomUUID(),
        at: "2026-11-26T12:00:00.000Z",
        run_id: null,
        task_id: null,
        opportunity_id: null,
        revenue_path: "claim_site",
        rail: "stripe",
        reference,
        amount_gbp: 49,
        settled_at: "2026-11-26T12:00:00.000Z",
        test_mode,
      });
    const rows = await s.dailyRollups.range({ from: "2026-11-26", to: "2026-11-27" });
    expect(rows.map((r) => [r.dry_run, r.revenue_gbp])).toEqual([
      [false, 49],
      [true, 49],
    ]);
  });
});
