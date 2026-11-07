import type { Claim } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { agree } from "./agreement.ts";
import { buildFactAt } from "./build.ts";
import type { VerificationContext } from "./context.ts";
import { canonicalJson, stableUuid } from "./ids.ts";
import { ingestClaims } from "./ingest.ts";

/**
 * Golden set and accuracy/calibration (Phase 3).
 * Archie's hand-verified values are claims from source "human" (tier 1, method human). They settle the
 * fact (see build.ts) and form the truth set we measure every other source against.
 */
export async function humanClaim(
  entityId: string,
  field: string,
  value: Claim["value"],
  runId: string,
  at = new Date().toISOString(),
): Promise<Claim> {
  return {
    claim_id: await stableUuid(["human", entityId, field, at, canonicalJson(value)]),
    entity_id: entityId,
    raw_entity_ref: { source_id: entityId, name: null },
    field,
    value,
    source: "human",
    source_tier: 1,
    lane: "open",
    method: "human",
    evidence: { kind: "record", ref: `dashboard:archie@${at}` },
    observed_at: at,
    published_at: at,
    fetched_at: at,
    run_id: runId,
  };
}

/** Archie verifies some fields of a company (golden set sample). */
export async function recordGolden(
  storage: Storage,
  ctx: VerificationContext,
  entityId: string,
  values: Record<string, Claim["value"]>,
  reason: "sample" | "conflict" = "sample",
) {
  const run = await storage.runs.start({ kind: "golden" });
  const at = new Date().toISOString();
  const claims = await Promise.all(
    Object.entries(values).map(([f, v]) => humanClaim(entityId, f, v, run.run_id, at)),
  );
  await ingestClaims(storage, ctx, { run_id: run.run_id, fetched_at: at }, claims);
  await storage.golden.add(entityId, reason);
  await storage.runs.finish(run.run_id, "succeeded");
}

/** Resolving a conflict in the dashboard = a human claim, and the company joins the golden set. */
export async function resolveConflict(
  storage: Storage,
  ctx: VerificationContext,
  entityId: string,
  field: string,
  value: Claim["value"],
) {
  await recordGolden(storage, ctx, entityId, { [field]: value }, "conflict");
}

export interface AccuracyRow {
  source: string;
  field: string;
  n: number;
  correct: number;
  accuracy: number;
}

export interface CalibrationBucket {
  field: string | "all";
  bucket: string;
  n: number;
  mean_confidence: number;
  accuracy: number;
}

const BUCKETS = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001];

/**
 * Per source + field: how often each source's latest claim agrees with Archie's value.
 * Calibration: the fact we'd have served WITHOUT Archie's claim — does its confidence match how often
 * it's right? Also a Brier score (lower is better).
 */
export async function accuracyReport(storage: Storage, ctx: VerificationContext, now = Date.now()) {
  const golden = (await storage.golden.list()).map((g) => g.entity_id);
  const fields = [...ctx.registry.keys()];
  const usable = golden.length ? await storage.claims.listUsableFor(golden, fields) : [];
  const groups = new Map<string, typeof usable>();
  for (const u of usable) {
    const k = `${u.claim.entity_id}|${u.claim.field}`;
    groups.set(k, [...(groups.get(k) ?? []), u]);
  }
  const acc = new Map<string, { n: number; correct: number }>();
  const calib: { field: string; confidence: number; correct: boolean }[] = [];
  for (const [k, list] of groups) {
    const [entityId, field] = k.split("|") as [string, string];
    const def = ctx.registry.get(field);
    if (!def) continue;
    const humans = list
      .filter((u) => u.claim.source === "human")
      .sort((a, b) => a.claim.published_at.localeCompare(b.claim.published_at));
    const truth = humans.at(-1)?.claim.value;
    if (truth === undefined) continue;
    const others = list.filter((u) => u.claim.source !== "human");
    const latestBySource = new Map<string, Claim>();
    for (const u of others) {
      const prev = latestBySource.get(u.claim.source);
      if (!prev || u.claim.published_at >= prev.published_at)
        latestBySource.set(u.claim.source, u.claim);
    }
    for (const [source, c] of latestBySource) {
      const key = `${source}|${field}`;
      const a = acc.get(key) ?? { n: 0, correct: 0 };
      a.n++;
      if (agree(c.value, truth, def.tolerance)) a.correct++;
      acc.set(key, a);
    }
    const served = buildFactAt(entityId, field, others, ctx, now, "reconstructed");
    if (served && served.status !== "quarantined")
      calib.push({
        field,
        confidence: served.confidence,
        correct: agree(served.value, truth, def.tolerance),
      });
  }
  const accuracy: AccuracyRow[] = [...acc.entries()]
    .map(([k, v]) => {
      const [source, field] = k.split("|") as [string, string];
      return { source, field, n: v.n, correct: v.correct, accuracy: v.n ? v.correct / v.n : 0 };
    })
    .sort((a, b) => a.source.localeCompare(b.source) || a.field.localeCompare(b.field));
  const bucketise = (rows: typeof calib, field: string): CalibrationBucket[] =>
    BUCKETS.slice(0, -1).flatMap((lo, i) => {
      const hi = BUCKETS[i + 1] as number;
      const inB = rows.filter((r) => r.confidence >= lo && r.confidence < hi);
      if (!inB.length) return [];
      return [
        {
          field,
          bucket: `${lo.toFixed(1)}–${Math.min(1, hi).toFixed(1)}`,
          n: inB.length,
          mean_confidence: inB.reduce((a, r) => a + r.confidence, 0) / inB.length,
          accuracy: inB.filter((r) => r.correct).length / inB.length,
        },
      ];
    });
  const calibration = [
    ...bucketise(calib, "all"),
    ...[...new Set(calib.map((c) => c.field))].sort().flatMap((f) =>
      bucketise(
        calib.filter((c) => c.field === f),
        f,
      ),
    ),
  ];
  const brier = calib.length
    ? calib.reduce((a, r) => a + (r.confidence - (r.correct ? 1 : 0)) ** 2, 0) / calib.length
    : null;
  return {
    golden_companies: golden.length,
    accuracy,
    calibration,
    brier,
    facts_checked: calib.length,
  };
}
