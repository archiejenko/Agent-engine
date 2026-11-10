import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backtest,
  marginReport,
  moduleDigest,
  parseFramework,
  promoteModule,
  runModule,
  suggestWeights,
  writeSuggestion,
} from "@ae/opportunity";
import type { Storage } from "@ae/storage";
import {
  accuracyReport,
  computeDrift,
  recordGolden,
  resumeSource,
  runDriftCheck,
} from "@ae/verification";
import { fakeModel } from "../service.ts";
import type { GateCriterion } from "./phase2.ts";
import { buildSyntheticWorld } from "./synthetic-world.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Phase 3 gate (synthetic): accuracy + calibration per source/field; drift breach → pause; lead-gen
 * backtest reports lift; first suggested weight change written to (a copy of) the framework note;
 * weekly digests + margin report written.
 */
export async function runPhase3Gate(
  storage: Storage,
  root: string,
  o: { count: number; golden: number; outDir: string; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  mkdirSync(o.outDir, { recursive: true });
  const world = await buildSyntheticWorld(storage, fakeModel(), { count: o.count, log });
  const ctx = world.ctx;
  const truth = new Map(world.set.companies.map((c) => [c.number, c]));

  // 1. Golden set: a simulated Archie checks companies against the truth.
  const members = (await storage.universe.list(world.universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  for (const id of members.slice(0, o.golden)) {
    const t = truth.get(id);
    if (!t) continue;
    await recordGolden(storage, ctx, id, {
      employees_average: t.true_employees as number,
      company_status: t.status.toLowerCase(),
      registered_office_postcode: t.postcode,
    });
  }
  const acc = await accuracyReport(storage, ctx);
  log(`golden: ${acc.golden_companies} companies, ${acc.accuracy.length} source/field rows`);

  // 2. Drift: today's metrics vs a baseline where one feed used to be 10× bigger → breach → pause.
  const day = new Date().toISOString().slice(0, 10);
  const today = await computeDrift(storage, day);
  const victim =
    today.find((m) => m.source === "companies_house" && m.field === "company_status") ?? today[0];
  for (let d = 1; d <= 7; d++) {
    const past = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    await storage.drift.put(
      today.map((m) => ({ ...m, day: past, volume: m === victim ? m.volume * 10 : m.volume })),
    );
  }
  // A source is only judged after 3 complete runs: first check that it isn't, then add two earlier
  // complete runs (re-fetches of the same claims) and check again.
  const early = await runDriftCheck(storage, ctx, day);
  const notJudgedYet = early.not_evaluated.some((n) => n.source === victim?.source);
  const victimClaims = (await storage.claims.listUsableFor(null, [victim?.field as string]))
    .map((u) => u.claim)
    .filter((c) => c.source === victim?.source);
  for (const d of [9, 8]) {
    const at = new Date(Date.now() - d * 86_400_000).toISOString();
    const r = await storage.runs.start({ kind: "synthetic_refetch" });
    await storage.claims.record(victimClaims, { run_id: r.run_id, fetched_at: at });
    await storage.runs.finish(r.run_id, "succeeded");
  }
  const drift = await runDriftCheck(storage, ctx, day);
  const paused = await storage.pauses.active();
  const alertsWhilePaused = (
    await storage.alerts.list({ unacknowledged: true, limit: 500 })
  ).filter((a) => a.kind === "drift").length;
  for (const p of paused) await resumeSource(storage, p.source, p.field); // undo for the rest of the gate
  const alertsAfterResume = (
    await storage.alerts.list({ unacknowledged: true, limit: 500 })
  ).filter((a) => a.kind === "drift").length;

  // 3. Backtest with planted outcomes: new directors reply far more often.
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const asOf = "2026-09-30";
  const r = rng(7);
  for (const id of members) {
    const newcomer = Number(id.slice(-4)) % 4 === 0;
    if (r() < (newcomer ? 0.6 : 0.03)) {
      await storage.outcomes.add({
        opportunity_id: null,
        entity_id: id,
        module: fw.config.module,
        event: "positive_reply",
        value_bool: true,
        value_gbp: 800 + Math.round(r() * 2200),
        observed_at: `2026-10-${String(2 + Math.floor(r() * 25)).padStart(2, "0")}T10:00:00Z`,
        source: "system",
      });
    }
  }
  const bt = await backtest(storage, ctx, fw, { asOf });
  let promoted = "stays in pilot";
  try {
    await promoteModule(storage, fw, "gate");
    promoted = "promoted to live";
  } catch (e) {
    promoted = `stays in pilot (${(e as Error).message})`;
  }
  log(`backtest: lift ${bt.lift.toFixed(2)}×, ${promoted}`);

  // 4. Weight suggestion: leads proposed at as_of were actioned; outcomes linked; windows closed.
  const past = await runModule(
    storage,
    ctx,
    { ...fw, config: { ...fw.config, threshold: 0, explore_share: 0 } },
    { asOf },
  );
  const hits = new Map(
    (
      await storage.outcomes.forEntities(
        "positive_reply",
        "2026-09-30T00:00:00Z",
        "2026-11-01T00:00:00Z",
      )
    ).map((x) => [x.entity_id, x]),
  );
  for (const opp of past.opportunities) {
    await storage.opportunities.setStatus(opp.opportunity_id, "actioned");
    const h = hits.get(opp.entity_id);
    if (h)
      await storage.outcomes.add({ ...h, opportunity_id: opp.opportunity_id, source: "human" });
  }
  const s = await suggestWeights(storage, fw, new Date("2026-11-07T00:00:00Z"));
  const notePath = join(o.outDir, "lead_gen_sme_web.with-suggestion.md");
  if (s)
    writeFileSync(
      notePath,
      await writeSuggestion(
        storage,
        readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
        fw,
        s,
      ),
    );

  // 5. Digests.
  const d = await moduleDigest(storage, fw);
  const m = await marginReport(storage);
  writeFileSync(join(o.outDir, d.path.split("/").pop() as string), d.markdown);
  writeFileSync(join(o.outDir, m.path.split("/").pop() as string), m.markdown);

  const sources = new Set(acc.accuracy.map((a) => a.source));
  const criteria: GateCriterion[] = [
    {
      criterion: "Accuracy and calibration reported per source/field",
      status:
        acc.accuracy.length >= 3 && acc.calibration.length > 0 ? "passed (synthetic)" : "failed",
      evidence: `${acc.golden_companies} golden companies; ${acc.accuracy.map((a) => `${a.source}.${a.field} ${(a.accuracy * 100).toFixed(0)}% (n=${a.n})`).join(", ")}; ${acc.calibration.filter((c) => c.field === "all").length} calibration bands; Brier ${acc.brier?.toFixed(3) ?? "n/a"}; ${sources.size} sources`,
    },
    {
      criterion: "Drift monitoring pauses a source on a breach",
      status:
        notJudgedYet &&
        drift.breaches.length > 0 &&
        paused.length > 0 &&
        alertsWhilePaused > 0 &&
        alertsAfterResume === 0
          ? "passed (synthetic)"
          : "failed",
      evidence: `${notJudgedYet ? `not judged while ${victim?.source} had fewer than 3 complete runs` : `${victim?.source} already had 3+ complete runs before the check (so the "not judged yet" step couldn't be shown)`}; after 3: ${drift.metrics.length} source/field metrics today; resuming closed its drift alert (${alertsWhilePaused} → ${alertsAfterResume} open); breach on ${drift.breaches.map((b) => `${b.source}.${b.field} (${b.reasons.join("; ")})`).join(", ")}; ${paused.length} paused`,
    },
    {
      criterion: "Lead-gen backtest reports lift",
      status: bt.candidates > 0 ? "passed (synthetic)" : "failed",
      evidence: `as of ${bt.as_of}, ${bt.mode} mode, ${bt.window_days}-day window: precision@20 ${(bt.precision_at_20 * 100).toFixed(0)}%, base rate ${(bt.base_rate * 100).toFixed(1)}%, lift ${bt.lift.toFixed(2)}×, revenue lift ${bt.revenue_lift?.toFixed(2) ?? "n/a"}×; module ${promoted}`,
    },
    {
      criterion: "First suggested weight change written to the framework note",
      status: s ? "passed (synthetic)" : "failed",
      evidence: s
        ? `written to a COPY (${notePath}) so synthetic outcomes never touch your real note; suggested ${Object.entries(
            s.suggested,
          )
            .map(([k, v]) => `${k} ${v}`)
            .join(", ")} from ${s.evidence.closed} closed leads (${s.evidence.positives} positive)`
        : "not enough closed outcomes",
    },
    {
      criterion: "Weekly digest and margin report written",
      status: "passed (synthetic)",
      evidence: `${d.path.split("/").pop()} and ${m.path.split("/").pop()} in ${o.outDir}`,
    },
    {
      criterion: "Same, on real data (your golden set, real replies)",
      status: "live pending",
      evidence: "needs the live Phase 1–2 data and real outreach outcomes",
    },
  ];
  return { criteria, accuracy: acc, backtest: bt, suggestion: s, drift };
}
