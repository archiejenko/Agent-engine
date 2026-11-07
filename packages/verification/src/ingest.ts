import type { Claim } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "./context.ts";
import { rebuildFacts } from "./persist.ts";
import { checkClaims, contextFromClaims, type EntityContext } from "./sanity.ts";

export interface IngestStats {
  received: number;
  dropped_unknown_field: number;
  unanchored: number;
  rejected: number;
  inserted: number;
  facts_versions_written: number;
  facts_touched: number;
}

/**
 * The one path every claim takes into the engine:
 * field registry check → sanity rules → append (or observe) → rebuild affected facts.
 */
export async function ingestClaims(
  storage: Storage,
  ctx: VerificationContext,
  seen: { run_id: string; fetched_at: string },
  claims: Claim[],
): Promise<IngestStats> {
  const stats: IngestStats = {
    received: claims.length,
    dropped_unknown_field: 0,
    unanchored: 0,
    rejected: 0,
    inserted: 0,
    facts_versions_written: 0,
    facts_touched: 0,
  };

  // Unknown fields are logged and dropped, never guessed.
  const unknown = new Map<string, number>();
  const known = claims.filter((c) => {
    if (ctx.registry.has(c.field)) return true;
    const k = `${c.source}|${c.field}`;
    unknown.set(k, (unknown.get(k) ?? 0) + 1);
    return false;
  });
  for (const [k, n] of unknown) {
    const [source, field] = k.split("|") as [string, string];
    await storage.dropped.record(source, field, seen.run_id, n);
    stats.dropped_unknown_field += n;
  }
  stats.unanchored = known.filter((c) => c.entity_id === null).length;

  // Sanity rules per entity, with what we already know about it as context.
  const byEntity = new Map<string, Claim[]>();
  for (const c of known)
    if (c.entity_id) byEntity.set(c.entity_id, [...(byEntity.get(c.entity_id) ?? []), c]);
  const failures = [];
  for (const [entityId, list] of byEntity) {
    const base: EntityContext = {};
    for (const f of [
      "incorporation_date",
      "company_status",
      "dissolution_date",
      "employees_average",
    ] as const) {
      const fact = await storage.facts.getCurrent(entityId, f);
      if (fact) (base as Record<string, unknown>)[f] = fact.value;
    }
    failures.push(...checkClaims(list, contextFromClaims(list, base), ctx.verification.sanity));
  }

  const { inserted } = await storage.claims.record(known, seen);
  stats.inserted = inserted;
  if (failures.length) await storage.claims.reject(failures);
  stats.rejected = failures.length;

  const pairs = new Map<string, { entity_id: string; field: string }>();
  for (const c of known)
    if (c.entity_id)
      pairs.set(`${c.entity_id}|${c.field}`, { entity_id: c.entity_id, field: c.field });
  const r = await rebuildFacts(storage, ctx, [...pairs.values()], {
    run_id: seen.run_id,
    now: seen.fetched_at,
  });
  stats.facts_versions_written = r.versions_written;
  stats.facts_touched = r.touched;
  return stats;
}
