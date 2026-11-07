import { type Claim, combineLanes, toMillis, VerifiedFact } from "@ae/contracts";
import type { UsableClaim } from "@ae/storage";
import { agree } from "./agreement.ts";
import { type ConfidenceClaim, computeConfidence } from "./confidence.ts";
import { sourceInfo, type VerificationContext } from "./context.ts";

export type PointInTimeMode = "reconstructed" | "strict";

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

interface Known {
  claim: Claim;
  observations: number[]; // ms, sorted
  reliability: number;
  upstream: string;
  continuous: boolean;
}

function byTimeline(a: Known, b: Known): number {
  return (
    toMillis(a.claim.published_at) - toMillis(b.claim.published_at) ||
    toMillis(a.claim.observed_at) - toMillis(b.claim.observed_at) ||
    a.claim.claim_id.localeCompare(b.claim.claim_id)
  );
}

/**
 * Build the fact for one entity + field as it stood at `asOfMs`, from the claims we hold.
 *
 * - reconstructed: uses every claim published (made knowable) by asOf.
 * - strict: additionally only claims we had actually fetched by asOf (no hindsight).
 *
 * Returns null when nothing was knowable by then. Pure function: same inputs, same output.
 */
export function buildFactAt(
  entityId: string,
  field: string,
  usable: UsableClaim[],
  ctx: VerificationContext,
  asOfMs: number,
  mode: PointInTimeMode,
): VerifiedFact | null {
  const def = ctx.registry.get(field);
  if (!def) return null;

  const known: Known[] = [];
  for (const u of usable) {
    if (u.claim.entity_id !== entityId || u.claim.field !== field) continue;
    if (toMillis(u.claim.published_at) > asOfMs) continue;
    const obs = u.observations.map(toMillis).sort((a, b) => a - b);
    if (mode === "strict" && !obs.some((o) => o <= asOfMs)) continue;
    const info = sourceInfo(ctx, u.claim.source, u.claim.source_tier);
    known.push({ claim: u.claim, observations: obs, ...info });
  }
  if (known.length === 0) return null;

  // Each source's view at asOf: its latest claim, plus the unbroken run of earlier agreeing claims.
  const bySource = new Map<string, Known[]>();
  for (const k of known.sort(byTimeline)) {
    bySource.set(k.claim.source, [...(bySource.get(k.claim.source) ?? []), k]);
  }
  const views = [...bySource.values()].map((timeline) => {
    const current = timeline[timeline.length - 1] as Known;
    const run: Known[] = [current];
    for (let i = timeline.length - 2; i >= 0; i--) {
      const prev = timeline[i] as Known;
      if (!agree(prev.claim.value, current.claim.value, def.tolerance)) break;
      run.unshift(prev);
    }
    // When did the source last assert the current value, as of asOf?
    const visibleObs =
      mode === "strict" ? current.observations.filter((o) => o <= asOfMs) : current.observations;
    const lastObs = visibleObs.length
      ? Math.max(...visibleObs)
      : toMillis(current.claim.fetched_at);
    const assertedAtMs = current.continuous
      ? Math.min(asOfMs, lastObs) // a register keeps asserting its current state
      : Math.min(asOfMs, toMillis(current.claim.observed_at));
    return { current, run, assertedAtMs, lastObs: Math.min(asOfMs, lastObs) };
  });

  // Sources that copy the same upstream (e.g. the CH API and the CH bulk file) are one source: the
  // most recently fetched copy speaks for the upstream; older copies neither support nor conflict.
  const byUpstream = new Map<string, (typeof views)[0]>();
  for (const v of views) {
    const prev = byUpstream.get(v.current.upstream);
    if (
      !prev ||
      v.lastObs > prev.lastObs ||
      (v.lastObs === prev.lastObs && byTimeline(v.current, prev.current) > 0)
    ) {
      byUpstream.set(v.current.upstream, v);
    }
  }
  const freshest = [...byUpstream.values()];

  // Cluster agreeing views across sources, then score each cluster by independent reliability.
  const clusters: (typeof views)[] = [];
  for (const v of freshest) {
    const home = clusters.find((c) =>
      agree((c[0] as (typeof views)[0]).current.claim.value, v.current.claim.value, def.tolerance),
    );
    if (home) home.push(v);
    else clusters.push([v]);
  }
  const score = (c: typeof views) => {
    const best = new Map<string, number>();
    for (const v of c)
      best.set(
        v.current.upstream,
        Math.max(best.get(v.current.upstream) ?? 0, v.current.reliability),
      );
    return 1 - [...best.values()].reduce((p, r) => p * (1 - r), 1);
  };
  const ranked = clusters
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || newest(b.c) - newest(a.c));
  const winner = ranked[0] as { c: typeof views; s: number };
  const runnerUp = ranked[1];
  const isConflict =
    runnerUp !== undefined && winner.s - runnerUp.s < ctx.verification.triangulation.clear_margin;

  const supporting = winner.c.flatMap((v) => v.run);
  const conflictingViews = ranked.slice(1).flatMap((r) => r.c);
  const toConf = (v: (typeof views)[0]): ConfidenceClaim => ({
    reliability: v.current.reliability,
    upstream: v.current.upstream,
    assertedAtMs: v.assertedAtMs,
  });
  const confidence = computeConfidence({
    supporting: winner.c.map(toConf),
    conflicting: conflictingViews.map(toConf),
    lambda: ctx.confidence.conflict_penalty_lambda,
    halfLifeDays: def.half_life_days,
    asOfMs,
  });

  const representative = [...winner.c].sort(
    (a, b) => b.current.reliability - a.current.reliability || byTimeline(b.current, a.current),
  )[0] as (typeof views)[0];
  const validFrom = Math.min(...supporting.map((k) => toMillis(k.claim.published_at)));
  const firstObserved = Math.min(...supporting.map((k) => toMillis(k.claim.observed_at)));
  const newestAssertion = Math.max(...winner.c.map((v) => v.assertedAtMs));
  const lastVerified = Math.max(validFrom, ...winner.c.map((v) => v.lastObs));
  const expiresMs =
    def.shelf_life_days === null ? null : newestAssertion + def.shelf_life_days * DAY_MS;

  const status = isConflict
    ? "conflict"
    : expiresMs !== null && asOfMs > expiresMs
      ? "stale"
      : "verified";
  return VerifiedFact.parse({
    entity_id: entityId,
    field,
    value: representative.current.claim.value,
    confidence,
    supporting_claims: supporting.map((k) => k.claim.claim_id),
    conflicting_claims:
      status === "conflict" || conflictingViews.length
        ? conflictingViews.map((v) => v.current.claim.claim_id)
        : [],
    lane: combineLanes(supporting.map((k) => k.claim.lane)),
    valid_from: iso(validFrom),
    first_observed_at: iso(firstObserved),
    last_verified_at: iso(lastVerified),
    expires_at: expiresMs === null ? null : iso(expiresMs),
    status,
  });
}

function newest(c: { current: Known }[]): number {
  return Math.max(...c.map((v) => toMillis(v.current.claim.published_at)));
}
