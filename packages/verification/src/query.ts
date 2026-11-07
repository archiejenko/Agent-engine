import {
  type Caller,
  type Filter,
  type GetVerifiedFactsParams,
  parseGetVerifiedFactsParams,
  RequestVerificationParams,
  toMillis,
  type VerifiedFact,
} from "@ae/contracts";
import type { Storage, UsableClaim } from "@ae/storage";
import { buildFactAt, type PointInTimeMode } from "./build.ts";
import type { VerificationContext } from "./context.ts";
import { canonicalJson } from "./ids.ts";

/** Callers that may see conflict/stale/quarantined facts (for review). Everyone else gets verified only. */
const REVIEW_CALLERS: readonly Caller[] = ["dashboard", "internal"];

export class PointInTimeViolation extends Error {}

function group(usable: UsableClaim[]) {
  const m = new Map<string, UsableClaim[]>();
  for (const u of usable) {
    const k = `${u.claim.entity_id}|${u.claim.field}`;
    m.set(k, [...(m.get(k) ?? []), u]);
  }
  return m;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function matchesFilter(value: unknown, f: Filter): boolean {
  switch (f.op) {
    case "eq":
      return canonicalJson(value) === canonicalJson(f.value);
    case "in":
      return (
        Array.isArray(f.value) && f.value.some((v) => canonicalJson(v) === canonicalJson(value))
      );
    case "gte":
      return value !== null && cmp(value, f.value) >= 0;
    case "lte":
      return value !== null && cmp(value, f.value) <= 0;
    case "between":
      return (
        Array.isArray(f.value) &&
        value !== null &&
        cmp(value, f.value[0]) >= 0 &&
        cmp(value, f.value[1]) <= 0
      );
  }
}

/**
 * getVerifiedFacts — the ONLY way the opportunity engine, playbooks and the x402 endpoint read data.
 *
 * Point-in-time: facts are rebuilt from the claims knowable at asOf (published_at <= asOf; in strict
 * mode also fetched by us by asOf), with confidence as it stood then. Lane refusal: x402 and
 * human-check callers asking for licensed facts get LaneRefusedError.
 */
export async function getVerifiedFacts(
  storage: Storage,
  ctx: VerificationContext,
  input: GetVerifiedFactsParams,
): Promise<VerifiedFact[]> {
  const p = parseGetVerifiedFactsParams(input);
  const asOfMs = toMillis(p.asOf.length === 10 ? `${p.asOf}T23:59:59.999Z` : p.asOf);
  const mode: PointInTimeMode = p.mode;

  let entityIds: string[] | null = null;
  if (Array.isArray(p.entities)) entityIds = p.entities;
  else if (p.entities?.filters.length) {
    let set: Set<string> | null = null;
    for (const f of p.entities.filters) {
      const facts = group(await storage.claims.listUsableFor(set ? [...set] : null, [f.field]));
      const next = new Set<string>();
      for (const [k, list] of facts) {
        const [entityId] = k.split("|") as [string];
        const fact = buildFactAt(entityId, f.field, list, ctx, asOfMs, mode);
        if (
          fact &&
          fact.status === "verified" &&
          p.lanes.includes(fact.lane) &&
          matchesFilter(fact.value, f)
        ) {
          next.add(entityId);
        }
      }
      set = next;
    }
    entityIds = [...(set ?? [])];
    if (entityIds.length === 0) return [];
  }

  const grouped = group(await storage.claims.listUsableFor(entityIds, p.fields));
  const out: VerifiedFact[] = [];
  for (const [k, list] of grouped) {
    const [entityId, field] = k.split("|") as [string, string];
    const fact = buildFactAt(entityId, field, list, ctx, asOfMs, mode);
    if (!fact) continue;
    if (toMillis(fact.valid_from) > asOfMs) {
      throw new PointInTimeViolation(
        `${entityId}.${field} valid_from ${fact.valid_from} is after asOf`,
      );
    }
    if (!p.lanes.includes(fact.lane)) continue;
    if (!REVIEW_CALLERS.includes(p.caller) && fact.status !== "verified") continue;
    if (p.minConfidence > 0 && (fact.status === "stale" || fact.confidence < p.minConfidence))
      continue;
    out.push(fact);
  }
  return out.sort(
    (a, b) => a.entity_id.localeCompare(b.entity_id) || a.field.localeCompare(b.field),
  );
}

/** Ask verification to prioritise facts someone is about to act on (processed by the nightly job). */
export async function requestVerification(storage: Storage, input: unknown): Promise<void> {
  const p = RequestVerificationParams.parse(input);
  const rows = p.entities.flatMap((entity_id) =>
    p.fields.map((field) => ({ entity_id, field, reason: p.reason, deadline: p.deadline ?? null })),
  );
  await storage.verificationRequests.add(rows);
}
