/**
 * Confidence model v1 (CLAUDE.md §3.1):
 *
 *   c = (1 − Π_{i∈S}(1 − r_i)) × (1 − λ · Σ_{j∈K} r_j / (Σ_{i∈S} r_i + Σ_{j∈K} r_j)) × 2^(−age / h)
 *
 * S = independent supporting sources, K = independent conflicting sources (claims whose sources copy
 * the same upstream are collapsed into one, keeping the highest r), λ = conflict penalty,
 * h = field half-life in days, age = days since the newest supporting assertion.
 */
export interface ConfidenceClaim {
  reliability: number;
  upstream: string;
  /** When the source last asserted this value, as of the moment we're computing for (ms). */
  assertedAtMs: number;
}

export interface ConfidenceInput {
  supporting: ConfidenceClaim[];
  conflicting: ConfidenceClaim[];
  lambda: number;
  halfLifeDays: number | null;
  asOfMs: number;
}

const DAY_MS = 86_400_000;

/** Collapse claims that share an upstream: copies of one source are not independent evidence. */
export function independent(claims: ConfidenceClaim[]): number[] {
  const best = new Map<string, number>();
  for (const c of claims) best.set(c.upstream, Math.max(best.get(c.upstream) ?? 0, c.reliability));
  return [...best.values()];
}

export function computeConfidence(input: ConfidenceInput): number {
  const S = independent(input.supporting);
  if (S.length === 0) return 0;
  const supportingUpstreams = new Set(input.supporting.map((c) => c.upstream));
  // A source cannot both support and conflict; supporting wins (it's the source's current view).
  const K = independent(input.conflicting.filter((c) => !supportingUpstreams.has(c.upstream)));

  const agreement = 1 - S.reduce((p, r) => p * (1 - r), 1);
  const sumS = S.reduce((a, r) => a + r, 0);
  const sumK = K.reduce((a, r) => a + r, 0);
  const conflict = sumK === 0 ? 1 : 1 - input.lambda * (sumK / (sumS + sumK));

  const newest = Math.max(...input.supporting.map((c) => c.assertedAtMs));
  const ageDays = Math.max(0, (input.asOfMs - newest) / DAY_MS);
  const decay = input.halfLifeDays === null ? 1 : 2 ** (-ageDays / input.halfLifeDays);

  const c = agreement * Math.max(0, conflict) * decay;
  return Math.min(1, Math.max(0, c));
}
