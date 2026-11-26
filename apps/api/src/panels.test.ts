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
import {
  CACHEABLE_PANELS,
  holdoutEntities,
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

const HOLDOUT = "HOLDOUT1";
const RANKED = "RANKED01";
const SIMCO = "SIMCO001";
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
  await s.costEvents.add(cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 0.5 }));
  await s.costEvents.add(
    cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 9, synthetic: true, playbook: "sme_letter" }),
  );
  await s.costEvents.add(cost({ at: `${today}T01:00:00.000Z`, amount_gbp: 50, dry_run: true }));
  const keys = new FakeKeyStore();
  await new KeyRing(keys, s).set("ANTHROPIC_API_KEY", FAKE_KEY, "test");
  return { s, keys };
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

  it("the seeded holdout company never appears; the ranked one does (positive control)", async () => {
    for (const q of ["", "synthetic=1"]) {
      const res = await all(app, q);
      for (const [name, r] of Object.entries(res)) {
        expect(r.text, name).not.toContain(HOLDOUT);
        // The aggregate "Ranked vs holdout" lift is allowed (it names no company); arm fields are not.
        expect(r.text, name).not.toMatch(/"arm"|cohort/i);
      }
      expect(res.live_runs?.text).toContain(RANKED);
      expect(res.needs_you?.text).toContain(RANKED);
    }
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
  it("no panel reveals a holdout company there either", async () => {
    const s = await openSqliteStorage(":memory:");
    await runPhase5Gate(s, process.cwd(), { count: 400, leads: 3, letters: 3 });
    const holdout = [...(await holdoutEntities(s))];
    expect(holdout.length).toBeGreaterThan(0);
    const app = createApp({ runtime: "node", storage: () => s });
    for (const q of ["", "synthetic=1"])
      for (const [name, r] of Object.entries(await all(app, q))) {
        expect(r.status, name).toBe(200);
        for (const h of holdout) expect(r.text, name).not.toContain(h);
      }
  }, 60_000);
});

describe("toPanelResult guard", () => {
  const w = { from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" };
  const g = { includeSynthetic: false, holdout: new Set([HOLDOUT]) };
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

  it("drops holdout rows and arm/cohort fields", () => {
    const r = toPanelResult(
      "x",
      {
        ...base,
        rows: [
          { key: "1", label: "a", entity_id: HOLDOUT },
          { key: "2", label: "b", ref: `lead:sme:entity:${HOLDOUT}` },
          { key: "3", label: "c", entity_id: RANKED, arm: "ranked", cohort_id: "c1" },
        ],
      },
      w,
      g,
    );
    expect(r.rows).toEqual([{ key: "3", label: "c", entity_id: RANKED }]);
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
    expect(body.note).toBe("record a top-up in Controls");
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
    expect(body.note).toBe("compared with 2026-10-22 to 2026-10-31");
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
      "brief",
      "kpis",
      "live_runs",
      "money_by_day",
      "pipeline",
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
