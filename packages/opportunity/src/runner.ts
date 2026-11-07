import {
  combineLanes,
  type Opportunity,
  type TraceItem,
  toMillis,
  type VerifiedFact,
} from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type PointInTimeMode, type VerificationContext } from "@ae/verification";
import type { FactMap } from "./facts.ts";
import type { Framework } from "./framework.ts";
import { SIGNALS, signalInputs } from "./signals.ts";

/**
 * Module runner: filter universe → drop facts below the confidence floor → compute signals →
 * normalise → transparent weighted sum → rank → threshold → exploration slots → expected value.
 * Every opportunity carries a full trace (signal value, weight, contribution, fact ids).
 */
export interface ModuleRunResult {
  run_id: string;
  as_of: string;
  mode: PointInTimeMode;
  candidates: number;
  opportunities: (Opportunity & { rank: number })[];
  /** Every scored candidate (for backtests), best first. */
  scored: { entity_id: string; score: number; confidence: number }[];
}

export const NEUTRAL = 0.5;
export const EXPLORE_BAND = 0.15;

function seeded(seedText: string) {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function winProbability(score: number, baseWinRate: number): number {
  return Math.min(1, (baseWinRate * score) / 0.5);
}

export interface ScoreDetail {
  score: number;
  trace: TraceItem[];
  confidence: number;
  lane: "open" | "licensed";
  evidence: number;
}

/** Score one entity from its facts. Pure: same facts + config → same score. */
export function scoreEntity(facts: FactMap, fw: Framework, asOfMs: number): ScoreDetail {
  const trace: TraceItem[] = [];
  const used: VerifiedFact[] = [];
  let evidence = 0;
  for (const [id, cfg] of Object.entries(fw.config.signals).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const s = SIGNALS[id];
    if (!s) throw new Error(`unknown signal ${id}`);
    const r = s.compute(facts, asOfMs);
    let normalised = r.value === null ? NEUTRAL : s.normalise(r.value);
    if (r.value !== null && cfg.invert) normalised = 1 - normalised;
    if (r.value !== null) {
      evidence++;
      for (const fid of r.fact_ids) {
        const f = [...facts.values()].find(
          (x) => `${x.entity_id}/${x.field}/${x.valid_from}` === fid,
        );
        if (f) used.push(f);
      }
    }
    trace.push({
      signal_id: id,
      signal_version: s.def.version,
      raw_value: r.value,
      normalised,
      weight: cfg.weight,
      contribution: cfg.weight * normalised,
      fact_ids: r.fact_ids,
    });
  }
  const score = trace.reduce((a, t) => a + t.contribution, 0);
  return {
    score,
    trace,
    confidence: used.length ? Math.min(...used.map((f) => f.confidence)) : 0,
    lane: combineLanes(used.map((f) => f.lane)),
    evidence,
  };
}

export async function runModule(
  storage: Storage,
  ctx: VerificationContext,
  fw: Framework,
  o: { asOf: string; mode?: PointInTimeMode; persist?: boolean; entities?: string[] },
): Promise<ModuleRunResult> {
  const mode = o.mode ?? "reconstructed";
  const asOfMs = toMillis(o.asOf.length === 10 ? `${o.asOf}T23:59:59.999Z` : o.asOf);
  const cfg = fw.config;
  const universeName = (cfg.universe as Record<string, string>).members_of as string;
  const members =
    o.entities ??
    (await storage.universe.list(universeName, { included: true })).map((m) => m.entity_id);
  const ids = Object.keys(cfg.signals);
  const facts = await getVerifiedFacts(storage, ctx, {
    entities: members.length ? members : ["00000000"],
    fields: signalInputs(ids),
    minConfidence: cfg.confidence_floor, // facts below the floor are dropped (signal → neutral)
    asOf: o.asOf,
    lanes: cfg.lanes,
    caller: "opportunity",
    mode,
  });
  const byEntity = new Map<string, FactMap>();
  for (const f of facts) {
    const m = byEntity.get(f.entity_id) ?? new Map();
    m.set(f.field, f);
    byEntity.set(f.entity_id, m);
  }

  const scored = members
    .map((id) => ({ id, d: scoreEntity(byEntity.get(id) ?? new Map(), fw, asOfMs) }))
    .filter((x) => x.d.evidence > 0) // nothing known → not an opportunity
    .sort((a, b) => b.d.score - a.d.score || a.id.localeCompare(b.id));

  const above = scored.filter((x) => x.d.score >= cfg.threshold);
  const band = scored.filter(
    (x) => x.d.score < cfg.threshold && x.d.score >= cfg.threshold - EXPLORE_BAND,
  );
  const k = Math.min(band.length, Math.round(cfg.explore_share * above.length));
  const rand = seeded(`${cfg.module}:${cfg.version}:${o.asOf}`);
  const pool = [...band];
  const explore: typeof band = [];
  for (let i = 0; i < k; i++)
    explore.push(pool.splice(Math.floor(rand() * pool.length), 1)[0] as (typeof band)[0]);

  const run = await storage.runs.start({
    kind: `module:${cfg.module}`,
    config_versions: { note_hash: fw.note_hash.slice(0, 12) },
  });
  const econ = cfg.economics ?? { deal_value_gbp: 1000, base_win_rate: 0.02 };
  const opportunities = [
    ...above.map((x) => ({ ...x, explore: false })),
    ...explore.map((x) => ({ ...x, explore: true })),
  ].map((x, i): Opportunity & { rank: number } => ({
    opportunity_id: crypto.randomUUID(),
    module: cfg.module,
    module_version: cfg.version,
    note_hash: fw.note_hash,
    entity_id: x.id,
    as_of: o.asOf,
    score: x.d.score,
    expected_value_gbp: winProbability(x.d.score, econ.base_win_rate) * econ.deal_value_gbp,
    confidence: x.d.confidence,
    trace: x.d.trace,
    lane: x.d.lane,
    explore: x.explore,
    status: "proposed",
    rank: i + 1,
  }));

  if (o.persist !== false) {
    await storage.signals.putMany(
      scored.flatMap((x) =>
        x.d.trace.map((t) => ({
          signal_id: t.signal_id,
          signal_version: t.signal_version,
          entity_id: x.id,
          as_of: o.asOf,
          value: t.raw_value,
          fact_ids: t.fact_ids,
        })),
      ),
      run.run_id,
    );
    await storage.opportunities.putMany(opportunities, run.run_id);
    await storage.moduleRuns.put({
      run_id: run.run_id,
      module: cfg.module,
      module_version: cfg.version,
      note_hash: fw.note_hash,
      as_of: o.asOf,
      mode,
      candidates: scored.length,
      above_threshold: above.length,
      explore: explore.length,
    });
  }
  await storage.runs.finish(run.run_id, "succeeded");
  return {
    run_id: run.run_id,
    as_of: o.asOf,
    mode,
    candidates: scored.length,
    opportunities,
    scored: scored.map((x) => ({ entity_id: x.id, score: x.d.score, confidence: x.d.confidence })),
  };
}
