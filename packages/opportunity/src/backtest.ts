import { type InfraConfig, loadInfraConfig } from "@ae/config";
import { toMillis } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import {
  type PointInTimeMode,
  PointInTimeViolation,
  type VerificationContext,
} from "@ae/verification";
import type { Framework } from "./framework.ts";
import { runModule, winProbability } from "./runner.ts";

/**
 * Backtester (Phase 3). Replays a module at a past date using only what was knowable then
 * (guardrail 2: any input fact with valid_from after as_of fails the backtest), then scores the
 * ranking against what actually happened in the outcome window.
 * Every report states its point-in-time mode.
 */
/** Guardrail 2: throws if any fact behind any opportunity was knowable only after as_of. */
export function assertNoLookAhead(opps: { trace: { fact_ids: string[] }[] }[], asOf: string): void {
  const asOfMs = toMillis(asOf.length === 10 ? `${asOf}T23:59:59.999Z` : asOf);
  for (const opp of opps) {
    for (const t of opp.trace) {
      for (const id of t.fact_ids) {
        const validFrom = id.split("/")[2] as string;
        if (toMillis(validFrom) > asOfMs)
          throw new PointInTimeViolation(`backtest used ${id}, knowable only after ${asOf}`);
      }
    }
  }
}

export interface BacktestReport {
  id: string;
  module: string;
  module_version: number;
  as_of: string;
  mode: PointInTimeMode;
  window_days: number;
  candidates: number;
  positives: number;
  precision_at_20: number;
  base_rate: number;
  lift: number;
  revenue_lift: number | null;
  calibration: { bucket: string; n: number; predicted: number; observed: number }[];
}

export async function backtest(
  storage: Storage,
  ctx: VerificationContext,
  fw: Framework,
  o: { asOf: string; mode?: PointInTimeMode; windowDays?: number; persist?: boolean },
): Promise<BacktestReport> {
  const mode = o.mode ?? "reconstructed";
  const window = o.windowDays ?? fw.config.outcome.window_days;
  const run = await runModule(storage, ctx, fw, { asOf: o.asOf, mode, persist: false });
  const asOfMs = toMillis(o.asOf.length === 10 ? `${o.asOf}T23:59:59.999Z` : o.asOf);

  // Guardrail 2, re-checked on every fact id the ranking used.
  assertNoLookAhead(run.opportunities, o.asOf);

  const end = new Date(asOfMs + window * 86_400_000).toISOString();
  const outcomes = await storage.outcomes.forEntities(
    fw.config.outcome.event,
    new Date(asOfMs).toISOString(),
    end,
  );
  const value = new Map<string, number>();
  for (const oc of outcomes) {
    if (oc.value_bool === false) continue;
    value.set(oc.entity_id, Math.max(value.get(oc.entity_id) ?? 0, oc.value_gbp ?? 1));
  }
  const ranked = run.scored;
  const n = ranked.length;
  const positives = ranked.filter((r) => value.has(r.entity_id)).length;
  const top = ranked.slice(0, 20);
  const precision = top.length ? top.filter((r) => value.has(r.entity_id)).length / top.length : 0;
  const base = n ? positives / n : 0;
  const totalValue = ranked.reduce((a, r) => a + (value.get(r.entity_id) ?? 0), 0);
  const topValue = top.reduce((a, r) => a + (value.get(r.entity_id) ?? 0), 0);
  const revenueLift =
    totalValue > 0 && top.length ? topValue / top.length / (totalValue / n) : null;

  const econ = fw.config.economics ?? { deal_value_gbp: 1000, base_win_rate: 0.02 };
  const deciles = 5;
  const calibration = Array.from({ length: deciles }, (_, i) => {
    const slice = ranked.slice(Math.floor((i * n) / deciles), Math.floor(((i + 1) * n) / deciles));
    return {
      bucket: `${i * 20}–${(i + 1) * 20}% of ranking`,
      n: slice.length,
      predicted: slice.length
        ? slice.reduce((a, r) => a + winProbability(r.score, econ.base_win_rate), 0) / slice.length
        : 0,
      observed: slice.length
        ? slice.filter((r) => value.has(r.entity_id)).length / slice.length
        : 0,
    };
  });

  const report: BacktestReport = {
    id: crypto.randomUUID(),
    module: fw.config.module,
    module_version: fw.config.version,
    as_of: o.asOf,
    mode,
    window_days: window,
    candidates: n,
    positives,
    precision_at_20: precision,
    base_rate: base,
    lift: base > 0 ? precision / base : 0,
    revenue_lift: revenueLift,
    calibration,
  };
  if (o.persist !== false) {
    await storage.backtests.put({
      id: report.id,
      module: report.module,
      module_version: report.module_version,
      note_hash: fw.note_hash,
      as_of: report.as_of,
      mode,
      window_days: window,
      candidates: n,
      precision_at_20: precision,
      base_rate: base,
      lift: report.lift,
      revenue_lift: revenueLift,
      calibration,
    });
  }
  return report;
}

/** Modules start in pilot; they go live only with a backtest of the current version at ≥ min lift. */
export const moduleStatusKey = (module: string) => `module:status:${module}`;

export async function moduleStatus(storage: Storage, module: string): Promise<"pilot" | "live"> {
  return (await storage.controls.get<"pilot" | "live">(moduleStatusKey(module))) ?? "pilot";
}

export async function promoteModule(
  storage: Storage,
  fw: Framework,
  by: string,
  cfg: InfraConfig = loadInfraConfig(),
) {
  const b = await storage.backtests.latest(fw.config.module);
  if (!b) throw new Error(`no backtest for ${fw.config.module} yet`);
  if (b.module_version !== fw.config.version || b.note_hash !== fw.note_hash)
    throw new Error("the latest backtest was for a different version of the note: re-run it");
  if (b.lift < cfg.modules.min_live_lift)
    throw new Error(
      `lift ${b.lift.toFixed(2)}× is below the ${cfg.modules.min_live_lift}× needed to go live`,
    );
  await storage.controls.set(moduleStatusKey(fw.config.module), "live", by);
  await storage.alerts.raise(
    "module_live",
    `${fw.config.module} v${fw.config.version} is live (backtest lift ${b.lift.toFixed(2)}×, mode ${b.mode})`,
    b,
  );
}
