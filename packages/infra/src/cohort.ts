import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type VerificationContext } from "@ae/verification";
import { contactStatus, outreachRoutes } from "./contact.ts";
import type { Channel } from "./ev.ts";
import { accountantFlags, letterSuppressionKey } from "./playbooks/sme_letter.ts";

/**
 * Who may be contacted at all, and how (v2 Phase 1). The same checks apply to ranked leads and to the
 * random holdout (v2 rule 16): suppression, the per-company cooldown, PECR routing (email only to a
 * verified role address at a corporate subscriber, otherwise a letter), and for letters a verified,
 * deliverable registered office that isn't flagged as an accountant's or agent's (we hold no trading
 * address to use instead).
 */
export interface Candidate {
  entity_id: string;
  eligible: boolean;
  channel: Channel | null;
  reason: string | null;
}

export async function assessCandidates(
  storage: Storage,
  ctx: VerificationContext,
  cfg: InfraConfig,
  entityIds: string[],
): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  if (!entityIds.length) return out;
  const routes = await outreachRoutes(storage, ctx, cfg, entityIds);
  const facts = await getVerifiedFacts(storage, ctx, {
    entities: entityIds,
    fields: ["registered_office_address", "registered_office_flags"],
    minConfidence: 0,
    asOf: new Date().toISOString(),
    lanes: ["open"],
    caller: "playbook",
  });
  for (const id of entityIds) {
    const no = (reason: string) =>
      out.set(id, { entity_id: id, eligible: false, channel: null, reason });
    const cool = await contactStatus(storage, cfg, id);
    if (cool) {
      no(`cooldown: ${cool.reason}`);
      continue;
    }
    // The company asked not to be contacted (a letter opt-out by post, email or the short URL): that
    // covers email too. One suppression list for every channel.
    if (await storage.suppressions.isSuppressed(letterSuppressionKey(id))) {
      no("asked not to be contacted");
      continue;
    }
    const channel = routes.get(id) ?? "letter";
    if (channel === "letter") {
      const addr = facts.find(
        (f) =>
          f.entity_id === id && f.field === "registered_office_address" && f.status !== "stale",
      )?.value as Record<string, string> | undefined;
      const flags = facts.find((f) => f.entity_id === id && f.field === "registered_office_flags")
        ?.value as { undeliverable?: boolean } | undefined;
      if (!addr) {
        no("no verified registered office to write to");
        continue;
      }
      if (flags?.undeliverable) {
        no("registered office marked undeliverable");
        continue;
      }
      if (cfg.measurement.skip_flagged_registered_offices) {
        const shared = await storage.letters.sharedAddressCount(JSON.stringify(addr));
        const f = accountantFlags(addr, shared, cfg);
        if (f.length) {
          no(
            `registered office looks like an accountant's or agent's (${f[0]?.detail}); no trading address held`,
          );
          continue;
        }
      }
    }
    out.set(id, { entity_id: id, eligible: true, channel, reason: null });
  }
  return out;
}

/** FNV-1a 32-bit: a fast, deterministic hash so the same seed always draws the same companies. */
export function seededRank(seed: string, entityId: string): number {
  let h = 0x811c9dc5;
  const s = `${seed}:${entityId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** How many holdout companies a cohort of `ranked` sends gets, for a holdout share h: ranked × h / (1 − h). */
export function holdoutSize(ranked: number, share: number): number {
  if (ranked <= 0) return 0;
  return Math.max(1, Math.round((ranked * share) / (1 - share)));
}

/**
 * The holdout: `k` companies drawn uniformly at random (by a recorded seed, so it's reproducible) from the
 * eligible universe, ignoring rank. Companies already in any cohort, or excluded, are skipped.
 */
export async function drawHoldout(
  storage: Storage,
  ctx: VerificationContext,
  cfg: InfraConfig,
  o: { seed: string; k: number; universeName: string; exclude: Set<string> },
): Promise<Candidate[]> {
  if (o.k <= 0) return [];
  const already = await storage.cohorts.memberEntities();
  const pool = (await storage.universe.list(o.universeName, { included: true }))
    .map((m) => m.entity_id)
    .filter((id) => !o.exclude.has(id) && !already.has(id))
    .sort((a, b) => seededRank(o.seed, a) - seededRank(o.seed, b) || a.localeCompare(b));
  const picked: Candidate[] = [];
  for (let i = 0; i < pool.length && picked.length < o.k; i += 50) {
    const chunk = pool.slice(i, i + 50);
    const assessed = await assessCandidates(storage, ctx, cfg, chunk);
    for (const id of chunk) {
      const c = assessed.get(id);
      if (c?.eligible) picked.push(c);
      if (picked.length >= o.k) break;
    }
  }
  return picked;
}
