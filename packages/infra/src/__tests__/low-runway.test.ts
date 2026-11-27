import { loadDecisionsConfig, loadInfraConfig } from "@ae/config";
import type { CostEventRow, Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { K } from "../controls.ts";
import { type DecisionDeps, decide, expireDecisions, needsYou, openRequest } from "../decisions.ts";
import { runwayFigures } from "../runway.ts";

const NOW = new Date("2026-11-26T12:00:00.000Z");

const cost = (at: string, amount_gbp: number): CostEventRow => ({
  event_id: crypto.randomUUID(),
  at,
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
  unit: "call",
  quantity: 1,
  unit_price_gbp: amount_gbp,
  amount_gbp,
  price_table_version: "test",
  synthetic: false,
  dry_run: false,
  playbook: "sme_outreach",
  step_id: "writer",
});

const pool = (s: Storage, id: string, amount: number, kind: "topup" | "adjustment" = "topup") =>
  s.poolEvents.add({
    event_id: id,
    at: "2026-11-10T09:00:00.000Z",
    kind,
    amount_gbp: amount,
    approval_id: null,
    by: "archie",
    note: null,
  });

/** £30 topped up, £2 a day of live spend for the last 7 complete days: 16 ÷ 2 = 8 days of runway. */
async function lowWorld(threshold = 14) {
  const s = await openSqliteStorage(":memory:");
  await pool(s, "p1", 30);
  for (let d = 19; d <= 25; d++) await s.costEvents.add(cost(`2026-11-${d}T10:00:00.000Z`, 2));
  const deps: DecisionDeps = {
    storage: s,
    cfg: loadInfraConfig(),
    dcfg: { ...loadDecisionsConfig(), low_runway_days: threshold },
    now: () => NOW,
  };
  return { s, deps };
}
const lowRunwayDecisions = (s: Storage) =>
  s.decisions.list({ type: "top_up_or_pause", limit: 100 });

describe("low runway (cockpit U3)", () => {
  it("the threshold lives in config, default 14 days", () => {
    expect(loadDecisionsConfig().low_runway_days).toBe(14);
  });

  it("runway below the threshold opens one 'Top up or pause' decision; safe default = pause", async () => {
    const { s, deps } = await lowWorld();
    expect((await runwayFigures(s, NOW)).days).toBe(8);
    await needsYou(deps);
    await needsYou(deps);
    const open = await lowRunwayDecisions(s);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      status: "open",
      safe_default: "pause",
      recommended: "keep_running",
      money_at_stake_gbp: 16,
      money_kind: "real",
    });
    expect(open[0]?.options.map((o) => o.key)).toEqual(["keep_running", "pause"]);
  });

  it("is never repeated for the same top-up, whatever Archie chose; a new top-up starts a new episode", async () => {
    const { s, deps } = await lowWorld();
    await needsYou(deps);
    const [first] = await lowRunwayDecisions(s);
    await decide(deps, first?.id as string, "keep_running", "archie");
    await needsYou(deps);
    expect(await lowRunwayDecisions(s)).toHaveLength(1);
    // A £2 adjustment: still below 14 days, and a new pool event, so a new episode.
    await pool(s, "p2", 2, "adjustment");
    await needsYou(deps);
    await needsYou(deps);
    const all = await lowRunwayDecisions(s);
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.status === "open")).toHaveLength(1);
  });

  it("nothing opens at or above the threshold, before any top-up, or with no live spend", async () => {
    const { s, deps } = await lowWorld(8); // runway is exactly 8 days: not below 8
    await needsYou(deps);
    expect(await lowRunwayDecisions(s)).toHaveLength(0);
    const empty = await openSqliteStorage(":memory:");
    await needsYou({ ...deps, storage: empty });
    expect(await lowRunwayDecisions(empty)).toHaveLength(0);
    const idle = await openSqliteStorage(":memory:");
    await pool(idle, "p1", 1);
    await needsYou({ ...deps, storage: idle });
    expect(await lowRunwayDecisions(idle)).toHaveLength(0);
  });

  it("a missed deadline pauses the queue, recorded as defaulted with no approval (rule 19)", async () => {
    const { s, deps } = await lowWorld();
    await needsYou(deps);
    const approvals = (await s.ownerApprovals.list(100)).length;
    const later = { ...deps, now: () => new Date(NOW.getTime() + 49 * 3_600_000) };
    expect(await expireDecisions(later)).toBe(1);
    const [x] = await lowRunwayDecisions(s);
    expect(x).toMatchObject({ status: "defaulted", chosen_option: "pause", approval_id: null });
    expect(await s.controls.get<boolean>(K.queuePaused)).toBe(true);
    expect((await s.ownerApprovals.list(100)).length).toBe(approvals);
  });
});

describe("pool top-up through the decisions path", () => {
  const request = (deps: DecisionDeps, amount: number) =>
    openRequest(deps, {
      type: "pool_topup",
      source_ref: `pool:${crypto.randomUUID()}`,
      summary: "top up",
      option: "record",
      options: [
        { key: "record", label: "Record", effect: "" },
        { key: "cancel", label: "Cancel", effect: "" },
      ],
      money_at_stake_gbp: amount,
      context: { amount_gbp: amount, note: "card" },
    });

  it("a request records nothing; deciding 'record' writes the top-up with Archie's approval id", async () => {
    const { s, deps } = await lowWorld();
    const x = await request(deps, 50);
    expect(x.safe_default).toBe("cancel");
    expect(await s.poolEvents.list()).toHaveLength(1);
    const decided = await decide(deps, x.id, "record", "archie");
    const events = await s.poolEvents.list();
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({
      kind: "topup",
      amount_gbp: 50,
      approval_id: decided.approval_id,
      note: "card",
    });
    // £80 in, £14 spent: 66 ÷ 2 = 33 days.
    expect((await runwayFigures(s, NOW)).days).toBe(33);
  });

  it("cancel, or an unanswered request, records nothing", async () => {
    const { s, deps } = await lowWorld();
    await decide(deps, (await request(deps, 50)).id, "cancel", "archie");
    await request(deps, 70);
    await expireDecisions({ ...deps, now: () => new Date(NOW.getTime() + 25 * 3_600_000) });
    expect(await s.poolEvents.list()).toHaveLength(1);
  });
});
