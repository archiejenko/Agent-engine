import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadInfraConfig } from "@ae/config";
import { LedgerEvent } from "@ae/contracts";
import { InMemoryQueue } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { holdoutSize, seededRank } from "../cohort.ts";
import { DEMO_BEACON_JS, demoBeaconHash, instrumentDemoHtml } from "../demo-visits.ts";
import { estimatePaid, evGate } from "../ev.ts";
import { rateRatio } from "../lift.ts";
import { loadBundledPlaybooks } from "../playbook.ts";
import { checkCopyRules } from "../playbooks/sme_outreach.ts";
import { createTask } from "../tasks.ts";

const cfg = loadInfraConfig();
let storage: Storage;
beforeEach(async () => {
  storage = await openSqliteStorage(":memory:");
});

let n = 0;
const ev = (
  event: "sent" | "reply" | "paid",
  o: { synthetic?: boolean; dry_run?: boolean; at?: string; task?: string } = {},
) =>
  storage.outcomeLedger.record(
    LedgerEvent.parse({
      event,
      entity_id: "01234567",
      task_id: o.task ?? `t${n}`,
      playbook: "sme_outreach",
      playbook_version: 1,
      value_gbp: event === "paid" ? 1500 : null,
      value_kind: "actual",
      observed_at: o.at ?? new Date().toISOString(),
      source: "system",
      synthetic: o.synthetic ?? false,
      dry_run: o.dry_run ?? false,
      dedupe_key: `k${n++}`,
    }),
  );

describe("P(paid) learns from the real ledger only (v2 rules 10–12)", () => {
  it("cold start uses the configured priors, labelled as assumptions", async () => {
    const est = await estimatePaid(storage, cfg, "sme_outreach");
    expect(est.basis).toBe("prior");
    expect(est.p_reply).toBeCloseTo(cfg.measurement.priors.reply_rate);
    expect(est.p_close).toBeCloseTo(cfg.measurement.priors.close_rate);
    expect(est.assumptions.join(" ")).toMatch(/assumption/);
  });

  it("synthetic rows and dry-run rows never move the estimate", async () => {
    for (let i = 0; i < 50; i++) {
      await ev("sent", { synthetic: true, task: `s${i}` });
      await ev("reply", { synthetic: true, task: `s${i}` });
      await ev("sent", { dry_run: true, task: `d${i}` });
      await ev("reply", { dry_run: true, task: `d${i}` });
    }
    const est = await estimatePaid(storage, cfg, "sme_outreach");
    expect(est.evidence).toEqual({ sent: 0, reply: 0, paid: 0 });
    expect(est.basis).toBe("prior");
  });

  it("real outcomes move it; outcomes after asOf don't (point-in-time)", async () => {
    const before = new Date(Date.now() - 86_400_000).toISOString();
    for (let i = 0; i < 20; i++) {
      await ev("sent", { task: `r${i}` });
      await ev("reply", { task: `r${i}` });
    }
    const now = await estimatePaid(storage, cfg, "sme_outreach");
    expect(now.evidence.sent).toBe(20);
    expect(now.p_reply).toBeGreaterThan(cfg.measurement.priors.reply_rate);
    const then = await estimatePaid(storage, cfg, "sme_outreach", before);
    expect(then.evidence.sent).toBe(0);
    expect(then.p_reply).toBeCloseTo(cfg.measurement.priors.reply_rate);
  });

  it("Archie's review decisions (approvals, edits, review time) never change it", async () => {
    const { task } = await createTask(
      storage,
      cfg,
      await loadBundledPlaybooks(),
      new InMemoryQueue(),
      {
        idempotency_key: "opportunity:a",
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: "opportunity:a:entity:01234567",
        lane: "open",
      },
    );
    await ev("sent", { task: task.task_id });
    const a = await estimatePaid(storage, cfg, "sme_outreach");
    for (let i = 0; i < 10; i++) {
      await storage.approvals.add({
        task_id: task.task_id,
        step_id: "gate",
        item_shown: {},
        decision: i % 2 ? "approve" : "reject",
        edited_text: null,
      });
      await storage.examples.add({
        playbook: "sme_outreach",
        step_id: "write",
        task_id: task.task_id,
        original: "x",
        edited: "y",
      });
      await storage.reviewSessions.add({
        id: `r${i}`,
        item_type: "draft",
        item_id: task.task_id,
        task_ids: [task.task_id],
        started_at: new Date().toISOString(),
        decided_at: new Date().toISOString(),
        active_ms: 1000,
        synthetic: false,
      });
    }
    const b = await estimatePaid(storage, cfg, "sme_outreach");
    expect({ ...b, as_of: "" }).toEqual({ ...a, as_of: "" });
  });

  it("the scoring and targeting code never reads review decisions (static check)", () => {
    // Comments are stripped: the files may *say* they don't read approvals.
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const banned = /\.approvals\b|\.examples\b|reviewSessions|review_sessions|playbook_examples/;
    const infra = join(import.meta.dirname, "..");
    const files = ["ev.ts", "cohort.ts", "ledger.ts", "lift.ts"].map((f) => join(infra, f));
    const opp = join(import.meta.dirname, "../../../opportunity/src");
    for (const f of readdirSync(opp, { recursive: true }) as string[])
      if (f.endsWith(".ts") && !f.includes("test")) files.push(join(opp, f));
    for (const f of files) expect(strip(readFileSync(f, "utf8")), f).not.toMatch(banned);
  });
});

describe("expected-value send gate", () => {
  it("a letter goes only when EV ≥ k × its cost; email only when EV > 0", async () => {
    const est = await estimatePaid(storage, cfg, "sme_letter");
    expect(evGate(cfg, "letter", est).send).toBe(true); // priors: 0.03 × 0.15 × £1500 = £6.75
    const low = { ...est, p_paid: 0.0005 };
    const letter = evGate(cfg, "letter", low);
    expect(letter.send).toBe(false);
    expect(letter.reason).toMatch(/below 3 × letter cost/);
    expect(evGate(cfg, "email", low).send).toBe(true);
    expect(evGate(cfg, "email", { ...est, p_paid: 0 }).send).toBe(false);
  });
});

describe("holdout and lift maths", () => {
  it("the holdout draw is reproducible from its seed", () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(10_000_000 + i));
    const order = (seed: string) =>
      [...ids].sort((a, b) => seededRank(seed, a) - seededRank(seed, b)).slice(0, 10);
    expect(order("cohort-1")).toEqual(order("cohort-1"));
    expect(order("cohort-1")).not.toEqual(order("cohort-2"));
  });

  it("holdout size keeps the configured share of the cohort", () => {
    expect(holdoutSize(0, 0.15)).toBe(0);
    expect(holdoutSize(1, 0.15)).toBe(1);
    expect(holdoutSize(17, 0.15)).toBe(3); // 3 / 20 = 15%
    expect(holdoutSize(85, 0.15)).toBe(15);
  });

  it("rate ratio with a 95% interval (Katz), continuity-corrected at zero", () => {
    const r = rateRatio(20, 100, 10, 100);
    expect(r?.ratio).toBeCloseTo(2);
    expect(r?.ci95[0]).toBeCloseTo(0.9866, 3);
    expect(r?.ci95[1]).toBeCloseTo(4.0546, 3);
    const z = rateRatio(5, 100, 0, 20);
    expect(z?.ratio).toBeGreaterThan(1);
    expect(rateRatio(1, 0, 1, 10)).toBeNull();
  });
});

describe("truthful labelling (v2 rule 15)", () => {
  const brief = { entity_id: "01234567", company_name: "ACME LTD", facts: [], contact: {} };
  it("a sales approach that poses as a survey, research or a personal note fails", () => {
    for (const body of [
      "Would you take part in a short survey about your website?",
      "I'm doing a research project on Manchester firms.",
      "Just a personal note, not a sales pitch.",
    ]) {
      const reasons = checkCopyRules({ subject: "Hello", body, claims: [] }, brief as never);
      expect(reasons.join(" "), body).toMatch(/presents itself as/);
    }
  });
});

describe("demo page instrumentation", () => {
  it("adds a privacy line and one script whose hash the CSP allows", async () => {
    const html = instrumentDemoHtml(
      '<html><body><footer id="contact"><div class="wrap">x</div></footer></body></html>',
    );
    expect(html).toContain("No cookies are set");
    expect(html).toContain(`<script>${DEMO_BEACON_JS}</script>`);
    expect(await demoBeaconHash()).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(DEMO_BEACON_JS).not.toMatch(/cookie|userAgent|localStorage/);
  });
});
