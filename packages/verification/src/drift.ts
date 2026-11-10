import type { DriftRow, Storage } from "@ae/storage";
import type { VerificationContext } from "./context.ts";

/**
 * Drift monitoring (Phase 3): daily per source + field — volume (fetches), null rate, distribution
 * (mean for numbers, share of the most common value otherwise) and match rate (share anchored to a
 * company). Compared with the trailing baseline; a breach raises an alert and pauses that source+field,
 * so its claims can't make facts verified until Archie resumes it.
 */
export async function computeDrift(storage: Storage, day: string): Promise<DriftRow[]> {
  const rows = await storage.drift.claimsOnDay(day);
  const groups = new Map<string, typeof rows>();
  for (const r of rows)
    groups.set(`${r.source}|${r.field}`, [...(groups.get(`${r.source}|${r.field}`) ?? []), r]);
  const out: DriftRow[] = [];
  for (const [k, list] of groups) {
    const [source, field] = k.split("|") as [string, string];
    const isNull = (v: unknown) => v === null || v === "" || (Array.isArray(v) && v.length === 0);
    const nums = list.map((r) => r.value).filter((v): v is number => typeof v === "number");
    const counts = new Map<string, number>();
    for (const r of list)
      if (typeof r.value !== "number")
        counts.set(JSON.stringify(r.value), (counts.get(JSON.stringify(r.value)) ?? 0) + 1);
    out.push({
      day,
      source,
      field,
      volume: list.length,
      null_rate: list.filter((r) => isNull(r.value)).length / list.length,
      mean: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
      top_share: counts.size ? Math.max(...counts.values()) / list.length : null,
      match_rate: list.filter((r) => r.entity_id !== null).length / list.length,
    });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.field.localeCompare(b.field));
}

export interface DriftBreach {
  source: string;
  field: string;
  reasons: string[];
}

export function compareToBaseline(
  today: DriftRow,
  history: DriftRow[],
  cfg: VerificationContext["verification"]["drift"],
): string[] {
  if (history.length < cfg.min_baseline_days) return [];
  const avg = (f: (r: DriftRow) => number | null) => {
    const xs = history.map(f).filter((x): x is number => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const reasons: string[] = [];
  const vol = avg((r) => r.volume) as number;
  if (
    vol > 0 &&
    (today.volume / vol < cfg.volume_ratio_min || today.volume / vol > cfg.volume_ratio_max)
  ) {
    reasons.push(`volume ${today.volume} vs usual ${vol.toFixed(0)}`);
  }
  const nr = avg((r) => r.null_rate) as number;
  if (today.null_rate - nr > cfg.null_rate_increase_max)
    reasons.push(
      `empty values ${(today.null_rate * 100).toFixed(0)}% vs usual ${(nr * 100).toFixed(0)}%`,
    );
  const mr = avg((r) => r.match_rate) as number;
  if (mr - today.match_rate > cfg.match_rate_drop_max)
    reasons.push(
      `match rate ${(today.match_rate * 100).toFixed(0)}% vs usual ${(mr * 100).toFixed(0)}%`,
    );
  const mean = avg((r) => r.mean);
  if (
    mean !== null &&
    today.mean !== null &&
    mean !== 0 &&
    Math.abs(today.mean - mean) / Math.abs(mean) > cfg.mean_relative_change_max
  ) {
    reasons.push(`average ${today.mean.toFixed(1)} vs usual ${mean.toFixed(1)}`);
  }
  return reasons;
}

export async function runDriftCheck(
  storage: Storage,
  ctx: VerificationContext,
  day: string,
): Promise<{
  metrics: DriftRow[];
  breaches: DriftBreach[];
  /** Sources not judged yet: fewer than min_complete_runs complete runs so far. */
  not_evaluated: { source: string; complete_runs: number }[];
}> {
  const metrics = await computeDrift(storage, day);
  await storage.drift.put(metrics);
  const breaches: DriftBreach[] = [];
  const notEvaluated = new Map<string, number>();
  for (const m of metrics) {
    if (!notEvaluated.has(m.source)) {
      const n = await storage.drift.completeRuns(m.source, day);
      if (n < ctx.verification.drift.min_complete_runs) notEvaluated.set(m.source, n);
      else notEvaluated.set(m.source, -1);
    }
    if ((notEvaluated.get(m.source) as number) >= 0) continue;
    const history = await storage.drift.history(
      m.source,
      m.field,
      day,
      ctx.verification.drift.baseline_days,
    );
    const reasons = compareToBaseline(m, history, ctx.verification.drift);
    if (!reasons.length) continue;
    breaches.push({ source: m.source, field: m.field, reasons });
    await storage.pauses.pause(m.source, m.field, reasons.join("; "));
    await storage.alerts.raise("drift", `${m.source}.${m.field} paused: ${reasons.join("; ")}`, m);
  }
  return {
    metrics,
    breaches,
    not_evaluated: [...notEvaluated]
      .filter(([, n]) => n >= 0)
      .map(([source, complete_runs]) => ({ source, complete_runs })),
  };
}

/**
 * Resume a paused source+field, and close its drift alerts, so the dashboard never shows "paused" in
 * Alerts while Paused sources says none.
 */
export async function resumeSource(storage: Storage, source: string, field: string) {
  await storage.pauses.resume(source, field);
  for (const a of await storage.alerts.list({ unacknowledged: true, limit: 1000 })) {
    const d = a.details as { source?: string; field?: string } | null;
    if (a.kind === "drift" && d?.source === source && d?.field === field)
      await storage.alerts.acknowledge(a.id);
  }
}
