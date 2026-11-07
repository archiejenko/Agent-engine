import type { VerifiedFact } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { buildFactAt } from "./build.ts";
import type { VerificationContext } from "./context.ts";
import { canonicalJson } from "./ids.ts";

/** What makes a fact "different" enough to deserve a new version (confidence/freshness don't). */
function versionKey(f: VerifiedFact): string {
  return canonicalJson({
    value: f.value,
    supporting: [...f.supporting_claims].sort(),
    conflicting: [...f.conflicting_claims].sort(),
    status: f.status === "stale" ? "verified" : f.status,
    lane: f.lane,
    valid_from: f.valid_from,
  });
}

export interface RebuildStats {
  versions_written: number;
  touched: number;
  removed: number;
}

/**
 * Recompute the current fact for each entity + field from the claims and store it:
 * a new version when the answer changed, an in-place refresh when only freshness changed.
 */
export async function rebuildFacts(
  storage: Storage,
  ctx: VerificationContext,
  pairs: { entity_id: string; field: string }[],
  meta: { run_id: string; now: string },
): Promise<RebuildStats> {
  const stats: RebuildStats = { versions_written: 0, touched: 0, removed: 0 };
  const nowMs = Date.parse(meta.now);
  const byEntity = new Map<string, Set<string>>();
  for (const p of pairs)
    byEntity.set(p.entity_id, (byEntity.get(p.entity_id) ?? new Set()).add(p.field));

  const entityIds = [...byEntity.keys()];
  const fields = [...new Set(pairs.map((p) => p.field))];
  const usable = fields.length ? await storage.claims.listUsableFor(entityIds, fields) : [];
  const grouped = new Map<string, typeof usable>();
  for (const u of usable) {
    const k = `${u.claim.entity_id}|${u.claim.field}`;
    grouped.set(k, [...(grouped.get(k) ?? []), u]);
  }

  for (const [entityId, fieldSet] of byEntity) {
    for (const field of fieldSet) {
      const fact = buildFactAt(
        entityId,
        field,
        grouped.get(`${entityId}|${field}`) ?? [],
        ctx,
        nowMs,
        "reconstructed",
      );
      const current = await storage.facts.getCurrent(entityId, field);
      if (!fact) {
        if (current) {
          await storage.facts.removeCurrent(entityId, field);
          stats.removed++;
        }
        continue;
      }
      if (current && versionKey(current) === versionKey(fact)) {
        await storage.facts.touch(entityId, field, {
          last_verified_at: fact.last_verified_at,
          confidence: fact.confidence,
          expires_at: fact.expires_at,
          status: fact.status,
        });
        stats.touched++;
      } else {
        await storage.facts.put(fact, { run_id: meta.run_id, recorded_at: meta.now });
        stats.versions_written++;
      }
    }
  }
  return stats;
}
