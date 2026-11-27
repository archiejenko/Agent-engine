import { PANEL_QUERIES } from "@ae/contracts";
import { KeyRing } from "@ae/infra";
import { FakeKeyStore } from "@ae/ports";
import type { CostEventRow, Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.ts";
import { memoryCache } from "./cache.ts";
import { runPhase5Gate } from "./gates/phase5.ts";
import { markTestWorldLeadsSimulated } from "./gates/test-world.ts";
import {
  CACHEABLE_PANELS,
  PANELS,
  PanelRefused,
  parseFilters,
  runwayFigures,
  toPanelResult,
} from "./panels.ts";

/** The one shape every panel returns (cockpit UI plan §3.2). */
const Kind = z.enum(["real", "estimated", "assumed", "dry_run", "synthetic"]);
const Shape = z
  .object({
    query: z.enum(PANEL_QUERIES),
    kind: z.enum(["figures", "series", "rows", "stages"]),
    as_of: z.iso.datetime(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    note: z.string().nullable(),
    empty: z.string().min(1),
    synthetic_included: z.boolean(),
    figures: z
      .array(
        z.object({
          key: z.string(),
          label: z.string(),
          value: z.number().nullable(),
          unit: z.enum(["gbp", "count", "ratio", "minutes", "lift", "days"]),
          kind: Kind,
          note: z.string().nullable(),
        }),
      )
      .optional(),
    series: z
      .array(z.object({ day: z.iso.date(), revenue_gbp: z.number(), spend_gbp: z.number() }))
      .optional(),
    rows: z.array(z.object({ key: z.string(), label: z.string() })).optional(),
    stages: z
      .array(z.object({ key: z.string(), count: z.number(), kind: Kind, unit: z.string() }))
      .optional(),
  })
  .refine((r) => r[r.kind] !== undefined, "the payload named by kind is present");

// A neutral company number: the word "holdout" must never appear in a result, even inside an id.
const HOLDOUT = "HCO00001";
const RANKED = "RANKED01";
const SIMCO = "SIMCO001";
/** A company drawn only into a simulated cohort, whose draft decision carries no synthetic flag. */
const SIMLEAD = "SIMLEAD1";
const FAKE_KEY = "sk_test_FAKEKEYVALUE0123456789";
const today = new Date().toISOString().slice(0, 10);

const cost = (o: Partial<CostEventRow> & { at: string; amount_gbp: number }): CostEventRow => ({
  event_id: crypto.randomUUID(),
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
  unit_price_gbp: o.amount_gbp,
  price_table_version: "test",
  synthetic: false,
  dry_run: false,
  playbook: "sme_outreach",
  step_id: "writer",
  ...o,
});

async function task(
  s: Storage,
  entity: string,
  status: "running" | "awaiting_approval",
  synthetic = false,
) {
  const task_id = crypto.randomUUID();
  await s.tasks.insertIdempotent({
    task_id,
    idempotency_key: task_id,
    playbook: "sme_outreach",
    playbook_version: 2,
    revenue_path: "sme_outreach",
    source_ref: `lead:sme:entity:${entity}`,
    lane: "open",
    autonomy: "L0",
    status,
    budget_gbp: 0.4,
    revenue_gbp: 0,
    cost_gbp: 0.01,
    priority: "outreach",
    state: { outputs: { email_draft: { subject: `Hello ${entity}`, body: "b", claims: [] } } },
    ...(synthetic ? { synthetic: true } : {}),
  });
  return task_id;
}

/** A small world: a holdout company, a ranked one, a simulated one, live/dry/simulated spend, a key. */
async function fixture() {
  const s = await openSqliteStorage(":memory:");
  await s.cohorts.create({
    id: "c1",
    seed: "s",
    holdout_share: 0.2,
    ranked: 1,
    holdout: 1,
    synthetic: false,
  });
  for (const [entity, arm] of [
    [HOLDOUT, "holdout"],
    [RANKED, "ranked"],
  ] as const) {
    const t = await task(s, entity, "awaiting_approval");
    await task(s, entity, "running");
    await s.cohorts.addMember({
      cohort_id: "c1",
      entity_id: entity,
      arm,
      channel: "email",
      p_paid: 0.1,
      ev_gbp: 10,
      task_id: t,
      status: "assigned",
      reason: null,
    });
  }
  await task(s, SIMCO, "running", true);
  await s.cohorts.create({
    id: "c-sim",
    seed: "s",
    holdout_share: 0.2,
    ranked: 1,
    holdout: 0,
    synthetic: true,
  });
  const simTask = await task(s, SIMLEAD, "awaiting_approval");
  await s.cohorts.addMember({
    cohort_id: "c-sim",
    entity_id: SIMLEAD,
    arm: "ranked",
    channel: "email",
    p_paid: 0.1,
    ev_gbp: 10,
    task_id: simTask,
    status: "assigned",
    reason: null,
  });
  await s.costEvents.add(cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 0.5 }));
  await s.costEvents.add(
    cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 9, synthetic: true, playbook: "sme_letter" }),
  );
  await s.costEvents.add(cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 50, dry_run: true }));
  const keys = new FakeKeyStore();
  await new KeyRing(keys, s).set("ANTHROPIC_API_KEY", FAKE_KEY, "test");
  return { s, keys };
}

/** Every field name (at any depth) that would say which group something is in (rule 22). */
function armFields(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => armFields(x, `${path}[${i}]`));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/^(arm|cohort|cohort_id|cohorts)$|holdout/i.test(k) ? [`${path}.${k}`] : []),
      ...armFields(x, `${path}.${k}`),
    ]);
  return [];
}

const all = async (app: ReturnType<typeof createApp>, q: string) => {
  const out: Record<string, { status: number; text: string; body: Record<string, unknown> }> = {};
  for (const name of PANEL_QUERIES) {
    const r = await app.request(`/api/panels/${name}?${q}`);
    const text = await r.text();
    out[name] = { status: r.status, text, body: JSON.parse(text) };
  }
  return out;
};

describe("panel registry (cockpit UI plan §3.2)", () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    const { s, keys } = await fixture();
    app = createApp({ runtime: "node", storage: () => s, keys: () => keys });
  });

  it("has exactly the ten queries the layout contract allows", () => {
    expect(Object.keys(PANELS).sort()).toEqual([...PANEL_QUERIES].sort());
  });

  it("every query returns the shared shape, with and without simulated rows", async () => {
    for (const q of [
      "",
      "synthetic=1",
      "compare=0",
      "set=primary",
      "split=playbook",
      "group=agent",
    ]) {
      for (const [name, r] of Object.entries(await all(app, q))) {
        expect(r.status, `${name}?${q}`).toBe(200);
        const parsed = Shape.safeParse(r.body);
        expect(parsed.success, `${name}?${q}: ${parsed.error?.message}`).toBe(true);
      }
    }
  });

  it("holdout rows are kept but blind: the holdout company's draft is in Needs you, unlabelled", async () => {
    for (const q of ["", "synthetic=1"]) {
      const res = await all(app, q);
      for (const [name, r] of Object.entries(res)) {
        // No field anywhere says which group something is in.
        expect(armFields(r.body), name).toEqual([]);
        // The aggregate "Ranked vs holdout" lift is a label, not a field; nothing else names an arm.
        expect(r.text.replace(/Ranked vs holdout[^"]*/g, ""), name).not.toMatch(
          /holdout|"arm"|cohort/i,
        );
      }
      const rows = res.needs_you?.body.rows as { entity_id: string | null; type: string }[];
      // Both the holdout and the ranked company's drafts reach Archie, looking exactly alike.
      const hold = rows.find((r) => r.entity_id === HOLDOUT);
      const ranked = rows.find((r) => r.entity_id === RANKED);
      expect(hold?.type).toBe("draft");
      expect(Object.keys(hold ?? {}).sort()).toEqual(Object.keys(ranked ?? {}).sort());
      expect(res.live_runs?.text).toContain(HOLDOUT);
      expect(res.live_runs?.text).toContain(RANKED);
    }
  });

  it("needs_you respects the simulated switch, working the flag out from the task and cohort", async () => {
    const off = (await all(app, "")).needs_you?.body as {
      rows: { entity_id: string }[];
      meta: { total_open: number; shown: number };
    };
    expect(off.rows.map((r) => r.entity_id)).not.toContain(SIMLEAD);
    expect(off.rows.map((r) => r.entity_id)).not.toContain(SIMCO);
    const on = (await all(app, "synthetic=1")).needs_you?.body as {
      rows: { entity_id: string; kind?: string; synthetic?: boolean }[];
      meta: { total_open: number };
      synthetic_included: boolean;
    };
    expect(on.rows.find((r) => r.entity_id === SIMLEAD)).toMatchObject({
      kind: "synthetic",
      synthetic: true,
    });
    expect(on.synthetic_included).toBe(true);
    expect(on.meta.total_open).toBe(off.meta.total_open + 1);
  });

  it("the brief's waiting count is the Needs you count (same simulated filter)", async () => {
    for (const q of ["", "synthetic=1"]) {
      const res = await all(app, q);
      const total = (res.needs_you?.body.meta as { total_open: number } | undefined)?.total_open;
      const waiting = ((res.brief?.body.rows ?? []) as { key: string; label: string }[]).find(
        (r) => r.key === "waiting",
      );
      expect(waiting?.label).toBe(`${total} item(s) waiting for you`);
    }
  });

  it("the leaderboard shows playbooks active in the period; all=1 shows every playbook", async () => {
    type Board = { rows: { key: string; rank: number }[]; meta: Record<string, number> };
    const active = (await (await app.request("/api/panels/playbook_board")).json()) as Board;
    // Only sme_outreach had live (non-simulated) money: £0.50.
    expect(active.rows.map((r) => [r.key, r.rank])).toEqual([["sme_outreach", 1]]);
    const all = (await (await app.request("/api/panels/playbook_board?all=1")).json()) as Board;
    expect(active.meta).toEqual({ total: all.rows.length, active: 1, shown: 1 });
    expect(all.rows.length).toBeGreaterThan(5);
    expect(all.meta.shown).toBe(all.rows.length);
  });

  it("an unknown send carries its company link and what failed (key-shaped text masked)", async () => {
    const w = await openSqliteStorage(":memory:");
    const t = await task(w, RANKED, "running");
    await w.effects.start({
      key: "k1",
      task_id: t,
      tool: "send_email",
      dry_run: true,
      args: { recipients: ["a@example.test"], entity_id: RANKED },
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    await w.effects.finish("k1", "unknown", {}, "auth failed for sk_live_abcdef1234567890");
    const a = createApp({ runtime: "node", storage: () => w });
    const r = await a.request("/api/panels/needs_you");
    expect(r.status).toBe(200);
    const row = ((await r.json()) as { rows: Record<string, unknown>[] }).rows.find(
      (x) => x.type === "uncertain_effect",
    );
    expect(row).toMatchObject({
      company_drill: `/crm/${RANKED}`,
      failure: "auth failed for [hidden]",
      recipient: "a@example.test",
    });
    expect(((row?.options ?? []) as { label: string }[]).map((o) => o.label)).toEqual([
      "Mark as sent",
      "Mark as not sent",
      "Leave it",
    ]);
  });

  it("needs_you returns the top N and the total open count", async () => {
    const r = (await (await app.request("/api/panels/needs_you?limit=1")).json()) as {
      rows: { money_at_stake_gbp: number }[];
      meta: { total_open: number; shown: number };
    };
    expect(r.rows).toHaveLength(1);
    expect(r.meta).toEqual({ total_open: 2, shown: 1 });
  });

  it("simulated rows are left out by default, and labelled when included", async () => {
    const off = await all(app, "");
    for (const [name, r] of Object.entries(off)) {
      expect(r.text, name).not.toContain(SIMCO);
      expect(r.body.synthetic_included, name).toBe(false);
      expect(r.text, name).not.toContain('"kind":"synthetic"');
    }
    const spendOff = ((off.kpis?.body.figures ?? []) as { key: string; value: number }[]).find(
      (f) => f.key === "live_spend",
    );
    expect(spendOff?.value).toBe(0.5); // the £50 dry run and £9 simulated are left out

    const on = await all(app, "synthetic=1");
    const runs = on.live_runs?.body.rows as {
      entity_id?: string;
      kind?: string;
      synthetic?: boolean;
    }[];
    const sim = runs.find((r) => r.entity_id === SIMCO);
    expect(sim).toMatchObject({ kind: "synthetic", synthetic: true });
    expect(on.live_runs?.body.synthetic_included).toBe(true);
    const spendOn = (
      (on.kpis?.body.figures ?? []) as { key: string; value: number; kind: string }[]
    ).find((f) => f.key === "live_spend");
    expect(spendOn).toMatchObject({ value: 9.5, kind: "synthetic" });
  });

  it("a seeded fake key value never appears in any panel", async () => {
    for (const q of ["", "synthetic=1"])
      for (const [name, r] of Object.entries(await all(app, q)))
        expect(r.text, name).not.toContain(FAKE_KEY);
  });

  it("an unknown panel is a 404 and bad filters are a 400", async () => {
    expect((await app.request("/api/panels/drop_table")).status).toBe(404);
    expect((await app.request("/api/panels/kpis?from=yesterday")).status).toBe(400);
    expect((await app.request("/api/panels/spend_split?group=everyone")).status).toBe(400);
  });
});

describe("the gate's simulator world", () => {
  it("holdout companies stay in the panels, with no arm, cohort or holdout field anywhere", async () => {
    const s = await openSqliteStorage(":memory:");
    await runPhase5Gate(s, process.cwd(), { count: 400, leads: 3, letters: 3 });
    const holdout: string[] = [];
    for (const c of await s.cohorts.list({ includeSynthetic: true, limit: 100 }))
      for (const m of await s.cohorts.members(c.id))
        if (m.arm === "holdout") holdout.push(m.entity_id);
    expect(holdout.length).toBeGreaterThan(0);
    // Test data only (U2 answer b): the fake-Companies-House leads are marked simulated.
    expect(await markTestWorldLeadsSimulated(s)).toBeGreaterThan(0);
    const app = createApp({ runtime: "node", storage: () => s });
    const type = async (q: string) =>
      (
        (await (await app.request(`/api/panels/needs_you?limit=50&${q}`)).json()) as {
          rows: { type: string; kind?: string }[];
        }
      ).rows.filter((r) => r.type === "lead");
    expect(await type("")).toEqual([]);
    const on = await type("synthetic=1");
    expect(on.length).toBeGreaterThan(0);
    expect(on.every((r) => r.kind === "synthetic")).toBe(true);
    for (const q of ["", "synthetic=1"])
      for (const [name, r] of Object.entries(await all(app, q))) {
        expect(r.status, name).toBe(200);
        expect(armFields(r.body), name).toEqual([]);
      }
  }, 60_000);
});

describe("toPanelResult guard", () => {
  const w = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" };
  const g = { includeSynthetic: false };
  const base = { kind: "rows" as const, note: null, empty: "e" };

  it("refuses a field named like a secret, and a value shaped like a key", () => {
    expect(() =>
      toPanelResult("x", { ...base, rows: [{ key: "a", label: "a", api_key: "x" }] }, w, g),
    ).toThrow(PanelRefused);
    expect(() => toPanelResult("x", { ...base, meta: { client_secret: "x" } }, w, g)).toThrow(
      PanelRefused,
    );
    expect(() =>
      toPanelResult(
        "x",
        { ...base, rows: [{ key: "a", label: "sk_live_abcdef1234567890" }] },
        w,
        g,
      ),
    ).toThrow(PanelRefused);
  });

  it("keeps holdout rows and strips arm, cohort and holdout fields (blind, not drop)", () => {
    const r = toPanelResult(
      "x",
      {
        ...base,
        rows: [
          { key: "1", label: "a", entity_id: HOLDOUT, arm: "holdout", cohort_id: "c1" },
          { key: "2", label: "b", entity_id: RANKED, arm: "ranked", cohort: { id: "c1" } },
        ],
        meta: { holdout_count: 1, holdout_share: 0.2, total: 2 },
      },
      w,
      g,
    );
    expect(r.rows).toEqual([
      { key: "1", label: "a", entity_id: HOLDOUT },
      { key: "2", label: "b", entity_id: RANKED },
    ]);
    expect(r.meta).toEqual({ total: 2 });
  });

  it("drops simulated rows unless asked, and labels them when included", () => {
    const raw = {
      ...base,
      rows: [
        { key: "1", label: "a", synthetic: true },
        { key: "2", label: "b" },
      ],
    };
    expect(toPanelResult("x", raw, w, g).rows?.map((x) => x.key)).toEqual(["2"]);
    const on = toPanelResult("x", raw, w, { ...g, includeSynthetic: true });
    expect(on.rows?.[0]).toMatchObject({ synthetic: true, kind: "synthetic" });
    expect(on.synthetic_included).toBe(true);
  });

  it("rounds money to pennies and leaves other numbers alone", () => {
    const r = toPanelResult(
      "x",
      {
        kind: "figures",
        note: null,
        empty: "e",
        figures: [
          {
            key: "m",
            label: "m",
            value: 3.14179,
            previous: 1.005001,
            unit: "gbp",
            kind: "real",
            note: null,
          },
          { key: "r", label: "r", value: 0.123456, unit: "ratio", kind: "real", note: null },
        ],
        meta: { total_gbp: 12.3456, share: 0.98765 },
      },
      w,
      g,
    );
    expect(r.figures?.[0]).toMatchObject({ value: 3.14, previous: 1.01 });
    expect(r.figures?.[1]?.value).toBe(0.123456);
    expect(r.meta).toEqual({ total_gbp: 12.35, share: 0.98765 });
  });
});

describe("runway (Archie, 26 Nov 2026)", () => {
  it("matches a hand-worked example; dry-run, simulated and sandbox spend are ignored", async () => {
    const s = await openSqliteStorage(":memory:");
    const now = new Date("2026-11-26T12:00:00.000Z");
    await s.poolEvents.add({
      event_id: "p1",
      at: "2026-11-10T09:00:00.000Z",
      kind: "topup",
      amount_gbp: 100,
      approval_id: null,
      by: "archie",
      note: null,
    });
    await s.poolEvents.add({
      event_id: "p2",
      at: "2026-11-12T09:00:00.000Z",
      kind: "adjustment",
      amount_gbp: -10,
      approval_id: null,
      by: "archie",
      note: "typo",
    });
    // Before the first top-up: not the pool's money.
    await s.costEvents.add(cost({ at: "2026-11-01T10:00:00.000Z", amount_gbp: 50 }));
    await s.costEvents.add(cost({ at: "2026-11-15T10:00:00.000Z", amount_gbp: 6 }));
    // The last 7 complete days (19–25 Nov): £2 a day.
    for (let d = 19; d <= 25; d++)
      await s.costEvents.add(cost({ at: `2026-11-${d}T10:00:00.000Z`, amount_gbp: 2 }));
    await s.costEvents.add(cost({ at: "2026-11-26T08:00:00.000Z", amount_gbp: 1 })); // today
    // Ignored: dry run, simulated, sandbox.
    await s.costEvents.add(
      cost({ at: "2026-11-20T10:00:00.000Z", amount_gbp: 1000, dry_run: true }),
    );
    await s.costEvents.add(
      cost({ at: "2026-11-21T10:00:00.000Z", amount_gbp: 500, synthetic: true }),
    );
    await s.costEvents.add(
      cost({ at: "2026-11-22T10:00:00.000Z", amount_gbp: 300, mode: "sandbox" }),
    );

    // Balance: 100 − 10 − (6 + 7 × 2 + 1) = 69. Average: 14 ÷ 7 = 2 a day. Runway: 69 ÷ 2 = 34.5 days.
    // Top up by 26 Nov + 34 days = 30 Dec.
    expect(await runwayFigures(s, now)).toEqual({
      recorded: true,
      balance: 69,
      avg7: 2,
      days: 34.5,
      top_up_by: "2026-12-30",
      last_event_id: "p2",
    });
  });

  it("with no top-up recorded it shows – and says how to fix it, never a guess", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.costEvents.add(cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 3 }));
    const app = createApp({ runtime: "node", storage: () => s });
    const body = (await (await app.request("/api/panels/runway")).json()) as {
      note: string;
      figures: { key: string; value: number | null }[];
    };
    expect(body.figures.every((f) => f.value === null)).toBe(true);
    expect(body.note).toBe("record a top-up in Controls → Agent pool");
  });
});

describe("kpis with compare=1", () => {
  it("returns previous-period values over a window of the same length", async () => {
    const s = await openSqliteStorage(":memory:");
    await s.costEvents.add(cost({ at: "2026-11-05T10:00:00.000Z", amount_gbp: 3 }));
    await s.costEvents.add(cost({ at: "2026-10-25T10:00:00.000Z", amount_gbp: 7 }));
    await s.costEvents.add(cost({ at: "2026-10-21T10:00:00.000Z", amount_gbp: 100 })); // before both windows
    const app = createApp({ runtime: "node", storage: () => s });
    const body = (await (
      await app.request("/api/panels/kpis?from=2026-11-01&to=2026-11-10&compare=1")
    ).json()) as {
      from: string;
      to: string;
      note: string;
      figures: {
        key: string;
        value: number | null;
        previous?: number | null;
        change?: number | null;
        change_ratio?: number | null;
      }[];
    };
    // 1–10 Nov is 10 days, so the previous window is 22–31 Oct.
    expect([body.from, body.to]).toEqual(["2026-11-01T00:00:00.000Z", "2026-11-11T00:00:00.000Z"]);
    expect(body.note).toBe("2026-11-01 to 2026-11-10, compared with 2026-10-22 to 2026-10-31");
    const spend = body.figures.find((f) => f.key === "live_spend");
    expect(spend).toMatchObject({ value: 3, previous: 7, change: -4, change_ratio: -0.5714 });
    for (const f of body.figures.filter((x) => x.key !== "live_agents"))
      expect(f, f.key).toHaveProperty("previous");
    const off = (await (
      await app.request("/api/panels/kpis?from=2026-11-01&to=2026-11-10&compare=0")
    ).json()) as {
      figures: object[];
    };
    for (const f of off.figures) expect(f).not.toHaveProperty("previous");
  });

  it("the two windows share no day: an event at the boundary counts once, in the newer window", async () => {
    const s = await openSqliteStorage(":memory:");
    // Exactly at midnight on 1 Nov: the first instant of the current window.
    await s.costEvents.add(cost({ at: "2026-11-01T00:00:00.000Z", amount_gbp: 2 }));
    // The last millisecond of 31 Oct: the previous window only.
    await s.costEvents.add(cost({ at: "2026-10-31T23:59:59.999Z", amount_gbp: 5 }));
    for (const [id, at] of [
      ["at-boundary", "2026-11-01T00:00:00.000Z"],
      ["just-before", "2026-10-31T23:59:59.999Z"],
    ] as const)
      await s.reviewSessions.add({
        id,
        item_type: "draft",
        item_id: id,
        task_ids: [],
        started_at: at,
        decided_at: at,
        active_ms: 60_000,
        synthetic: false,
      });
    const app = createApp({ runtime: "node", storage: () => s });
    const body = (await (
      await app.request("/api/panels/kpis?from=2026-11-01&to=2026-11-10&compare=1")
    ).json()) as {
      meta: Record<string, string>;
      figures: { key: string; value: number | null; previous?: number | null }[];
    };
    expect(body.meta.previous_to).toBe(body.meta.period_from);
    expect(body.meta).toMatchObject({
      period_from: "2026-11-01T00:00:00.000Z",
      period_to: "2026-11-11T00:00:00.000Z",
      previous_from: "2026-10-22T00:00:00.000Z",
      previous_to: "2026-11-01T00:00:00.000Z",
    });
    const fig = (k: string) => body.figures.find((f) => f.key === k);
    expect(fig("live_spend")).toMatchObject({ value: 2, previous: 5 });
    expect(fig("review_minutes")).toMatchObject({ value: 1, previous: 1 });
  });

  it("defaults to the last 30 days, live only, compare on", () => {
    const f = parseFilters({}, new Date("2026-11-26T15:00:00Z"));
    expect(f).toEqual({
      from: "2026-10-28T00:00:00.000Z",
      to: "2026-11-27T00:00:00.000Z",
      days: 30,
      playbook: null,
      includeSynthetic: false,
      compare: true,
    });
  });
});

describe("panel caching (KV, 60 s)", () => {
  it("budget, cap and control panels are never served from KV; the others are", async () => {
    expect([...CACHEABLE_PANELS].sort()).toEqual([
      "board_heatmap",
      "brief",
      "crm_pipeline",
      "inbox_strip",
      "kpis",
      "live_runs",
      "money_by_day",
      "pipeline",
      "vault_learned",
    ]);
    const s = await openSqliteStorage(":memory:");
    const cache = memoryCache();
    const app = createApp({ runtime: "node", storage: () => s, cache: () => cache });
    for (const name of PANEL_QUERIES) {
      const first = await app.request(`/api/panels/${name}`);
      const second = await app.request(`/api/panels/${name}`);
      expect(first.status).toBe(200);
      if (PANELS[name].cacheable) {
        expect(first.headers.get("x-cache"), name).toBe("miss");
        expect(second.headers.get("x-cache"), name).toBe("hit");
      } else {
        expect(second.headers.get("x-cache"), name).toBeNull();
        expect(second.headers.get("cache-control"), name).toBe("no-store");
      }
    }
    expect(cache.size()).toBe(CACHEABLE_PANELS.length);
  });
});
