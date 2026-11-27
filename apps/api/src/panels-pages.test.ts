import { loadInfraConfig } from "@ae/config";
import { crmList, recordOutcome, writeAgentNote } from "@ae/infra";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { runPhase5Gate } from "./gates/phase5.ts";
import { seedIdeaFixtures } from "./gates/v3-phase6.ts";

/** Cockpit U3: the panel queries behind Ideas, Board, CRM, Inbox and the Vault. */
type Body = {
  note?: string;
  rows: Record<string, unknown>[];
  stages?: { key: string; count: number; value_gbp: number | null; share: number }[];
  meta?: Record<string, unknown>;
  value_kind?: string;
};

let s: Storage;
let app: ReturnType<typeof createApp>;
const get = async (q: string) => (await (await app.request(`/api/panels/${q}`)).json()) as Body;

beforeAll(async () => {
  s = await openSqliteStorage(":memory:");
  await runPhase5Gate(s, process.cwd(), { count: 400, leads: 3, letters: 3 });
  const entities = [
    ...new Set((await s.facts.listCurrent({ limit: 200, offset: 0 })).rows.map((f) => f.entity_id)),
  ];
  await seedIdeaFixtures(s, entities);
  // The seeded cards are all held back as underpowered (never shown). Add one card per board column,
  // built from a real seeded card, and an open idea decision for the new one.
  const base = (await s.ideaCards.list({ limit: 10 }))[0];
  if (!base) throw new Error("no seeded card");
  for (const [i, status] of ["proposed", "passed", "testing", "succeeded", "killed"].entries()) {
    const card_id = `card-test-${status}`;
    await s.ideaCards.add({
      ...base,
      card_id,
      version: 1,
      card: { ...(base.card as object), card_id, version: 1 },
      status,
      rank_value: 10 - i,
      synthetic: false,
    });
  }
  await s.decisions.open({
    type: "idea",
    source_ref: "card:card-test-proposed@1",
    summary: "Idea: test",
    money_at_stake_gbp: 10,
    money_kind: "estimated",
    options: [
      { key: "pass", label: "Pass", effect: "" },
      { key: "fail", label: "Fail", effect: "" },
      { key: "park", label: "Park", effect: "" },
    ],
    recommended: "pass",
    safe_default: "park",
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
    context: { card_id: "card-test-proposed", version: 1 },
    synthetic: false,
  });
  app = createApp({ runtime: "node", storage: () => s, vault: async () => [] });
}, 120_000);

describe("ideas_board", () => {
  it("puts every card in one of five columns, with the four figures and its plan status", async () => {
    const b = await get("ideas_board?synthetic=1");
    expect(b.stages?.map((x) => x.key)).toEqual([
      "new",
      "approved",
      "executing",
      "earning",
      "killed",
    ]);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.stages?.reduce((a, x) => a + x.count, 0)).toBe(b.rows.length);
    for (const r of b.rows) {
      const figs = r.figures as { key: string }[];
      expect(figs.map((f) => f.key)).toEqual([
        "cost_to_serve",
        "cost_to_acquire",
        "expected_revenue",
        "confidence",
      ]);
      expect(typeof r.plan_status).toBe("string");
    }
  });

  it("confidence is the lowest confidence among the card's evidence facts", async () => {
    const b = await get("ideas_board?synthetic=1");
    for (const r of b.rows) {
      const card = (await s.ideaCards.latest(r.key as string))?.card as {
        evidence: { fact_ids: string[] };
      };
      const confs: number[] = [];
      for (const id of card.evidence.fact_ids) {
        const [e, f] = id.split(":");
        const fact = await s.facts.getCurrent(e as string, f as string);
        if (fact) confs.push(fact.confidence);
      }
      const conf = (r.figures as { key: string; value: number | null }[]).find(
        (f) => f.key === "confidence",
      );
      expect(conf?.value).toBe(
        confs.length ? Math.round(Math.min(...confs) * 10_000) / 10_000 : null,
      );
    }
  });

  it("a card waiting for Archie carries its open decision (pass/fail/park via /decide)", async () => {
    const b = await get("ideas_board?synthetic=1");
    const open = b.rows.filter((r) => r.decision);
    expect(open.map((r) => r.key)).toEqual(["card-test-proposed"]);
    for (const r of open) {
      const d = r.decision as { id: string; options: { key: string }[] };
      expect(d.options.map((o) => o.key)).toContain("park");
      expect((await s.decisions.get(d.id))?.status).toBe("open");
    }
  });
});

describe("crm_pipeline", () => {
  it("column counts and values match the CRM list; each column shows its top companies", async () => {
    const b = await get("crm_pipeline?synthetic=1&limit=3");
    const all = (await crmList(s, { includeSynthetic: true, limit: 100_000, offset: 0 })).rows;
    for (const st of b.stages ?? []) {
      const inStage = all.filter((r) => r.stage === st.key);
      expect(st.count, st.key).toBe(inStage.length);
      const value = inStage.reduce((a, r) => a + (r.expected_value_gbp ?? 0), 0);
      expect(st.value_gbp, st.key).toBe(Math.round(value * 100) / 100);
      expect(b.rows.filter((r) => r.column === st.key).length).toBe(Math.min(3, inStage.length));
    }
  });
});

describe("board_heatmap", () => {
  it("colour = expected monthly profit per £1 of planned agent spend, scaled to the best market", async () => {
    const b = await get("board_heatmap?synthetic=1");
    expect(b.rows.length).toBeGreaterThan(0);
    type Cell = {
      intensity: number;
      spend_gbp: number;
      monthly_profit_per_gbp_spend: number | null;
      profit_per_hour_gbp: number | null;
    };
    const cells = b.rows.flatMap((r) => r.cells as Cell[]);
    // Worked out here from the cards: best (expected profit ÷ 12 ÷ test budget) per market.
    const tiles = await s.board.list();
    const expected: number[] = [];
    for (const t of tiles) {
      const cards = (await s.ideaCards.forMarket(t.market_key)).filter(
        (x) => !["superseded", "killed", "failed"].includes(x.status),
      );
      const per = cards
        .map(
          (x) =>
            x.card as {
              economics: { expected_profit: { value: number } };
              test: { budget_gbp: { value: number } };
            },
        )
        .filter((c) => c.test.budget_gbp.value > 0)
        .map((c) => c.economics.expected_profit.value / 12 / c.test.budget_gbp.value);
      if (per.length) expected.push(Math.round(Math.max(...per) * 10_000) / 10_000);
    }
    expect(
      cells
        .map((c) => c.monthly_profit_per_gbp_spend)
        .filter((x) => x !== null)
        .sort(),
    ).toEqual(expected.sort());
    const top = Math.max(...cells.map((c) => c.monthly_profit_per_gbp_spend ?? 0));
    for (const c of cells) {
      expect(c.intensity).toBeGreaterThanOrEqual(0);
      expect(c.intensity).toBeLessThanOrEqual(1);
      if (top > 0 && c.monthly_profit_per_gbp_spend === top) expect(c.intensity).toBe(1);
      expect(typeof c.spend_gbp).toBe("number");
    }
    // Profit per hour of Archie's time is kept for the hover text.
    expect(cells.some((c) => c.profit_per_hour_gbp !== null)).toBe(true);
    expect(b.value_kind).toBe("synthetic");
    expect(b.note).toMatch(/monthly profit per £1 of agent spend/);
  });
});

describe("inbox_strip", () => {
  it("counts sent, replies and positive replies per playbook; rates are per company sent to", async () => {
    const w = await openSqliteStorage(":memory:");
    const cfg = loadInfraConfig();
    const now = new Date().toISOString();
    const ev = (event: "sent" | "reply" | "reply_positive", entity: string, n: number) =>
      recordOutcome(w, cfg, {
        event,
        entity_id: entity,
        source: "system",
        dedupe_key: `${event}:${entity}:${n}`,
        observed_at: now,
      });
    for (let i = 0; i < 4; i++) await ev("sent", `CO00000${i}`, i);
    await ev("reply", "CO000000", 1);
    await ev("reply_positive", "CO000001", 2);
    const a = createApp({ runtime: "node", storage: () => w });
    const b = (await (await a.request("/api/panels/inbox_strip")).json()) as Body;
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({
      sent: 4,
      replies: 2,
      positive: 1,
      reply_rate: 0.5,
      positive_rate: 0.25,
    });
  });
});

describe("vault_learned", () => {
  it("lists this week's agent notes with their provenance; Archie's own notes aren't in it", async () => {
    const w = await openSqliteStorage(":memory:");
    await writeAgentNote(w, {
      path: "brain/learned/reply-times.md",
      body: "# Replies come in on Tuesdays\n",
      agent: "analyst",
      sources: ["ledger"],
      ledger_rows: [1, 2, 3],
      labels: ["assumed"],
    });
    await w.noteVersions.add({
      path: "brain/archie.md",
      body: "# Mine\n",
      author: "archie",
      provenance: null,
    } as never);
    const a = createApp({ runtime: "node", storage: () => w, vault: async () => [] });
    const b = (await (await a.request("/api/panels/vault_learned")).json()) as Body;
    expect(b.rows.map((r) => r.label)).toEqual(["Replies come in on Tuesdays"]);
    expect(b.rows[0]?.detail).toBe("by agent:analyst · 1 source(s) · 3 ledger row(s) · assumed");
    expect(b.rows[0]?.drill).toBe(`/vault/${encodeURIComponent("brain/learned/reply-times.md")}`);
  });
});
