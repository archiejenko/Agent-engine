import type { CompaniesHouseConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "./context.ts";
import { ingestClaims } from "./ingest.ts";
import { type CompaniesHouseClient, fetchCompanyBundle } from "./sources/companies-house/client.ts";
import { mapCompanyBundle } from "./sources/companies-house/mapper.ts";

/**
 * Nightly re-verification queue. Priority per company =
 *   value (explicit request > live opportunity > other) × staleness × uncertainty
 * where staleness = age since last verified ÷ shelf life and uncertainty = 1 − confidence (worst field).
 * Processes the top companies within the daily API call budget.
 */
export interface ReverifyPlan {
  entity_id: string;
  priority: number;
  reason: string;
  request_ids: string[];
}

export async function planReverification(
  storage: Storage,
  ctx: VerificationContext,
  now = Date.now(),
): Promise<ReverifyPlan[]> {
  const cfg = ctx.verification.reverify;
  const requests = await storage.verificationRequests.listOpen(10_000);
  const hot = new Set([
    ...(await storage.opportunities.list({ status: "proposed", limit: 100_000 })).map(
      (o) => o.entity_id,
    ),
    ...(await storage.opportunities.list({ status: "approved", limit: 100_000 })).map(
      (o) => o.entity_id,
    ),
  ]);
  const byEntity = new Map<string, { score: number; reason: string; request_ids: string[] }>();
  const bump = (id: string, score: number, reason: string, reqId?: string) => {
    const cur = byEntity.get(id) ?? { score: 0, reason, request_ids: [] };
    if (score > cur.score) {
      cur.score = score;
      cur.reason = reason;
    }
    if (reqId) cur.request_ids.push(reqId);
    byEntity.set(id, cur);
  };
  const facts = (await storage.facts.listCurrent({ limit: 1_000_000, offset: 0 })).rows;
  const worst = new Map<string, number>();
  for (const f of facts) {
    const def = ctx.registry.get(f.field);
    if (!def?.shelf_life_days) continue;
    const staleness = Math.min(
      2,
      (now - Date.parse(f.last_verified_at)) / (def.shelf_life_days * 86_400_000),
    );
    const uncertainty = 1 - f.confidence;
    worst.set(
      f.entity_id,
      Math.max(worst.get(f.entity_id) ?? 0, staleness * Math.max(0.05, uncertainty)),
    );
  }
  for (const [id, w] of worst)
    bump(
      id,
      w * (hot.has(id) ? cfg.opportunity_weight : 1),
      hot.has(id) ? "live opportunity, stale facts" : "stale facts",
    );
  for (const r of requests)
    bump(
      r.entity_id,
      cfg.request_weight * Math.max(0.5, worst.get(r.entity_id) ?? 0.5),
      `requested: ${r.reason}`,
      r.request_id,
    );
  return [...byEntity.entries()]
    .map(([entity_id, v]) => ({
      entity_id,
      priority: v.score,
      reason: v.reason,
      request_ids: v.request_ids,
    }))
    .sort((a, b) => b.priority - a.priority || a.entity_id.localeCompare(b.entity_id));
}

export async function nightlyReverify(
  storage: Storage,
  ctx: VerificationContext,
  client: CompaniesHouseClient,
  chConfig: CompaniesHouseConfig,
  o: { now?: number; budgetCalls?: number } = {},
) {
  const plan = await planReverification(storage, ctx, o.now);
  const budget = o.budgetCalls ?? ctx.verification.reverify.daily_call_budget;
  const maxCompanies = Math.floor(budget / ctx.verification.reverify.calls_per_company);
  const chosen = plan.slice(0, maxCompanies);
  const run = await storage.runs.start({ kind: "reverify" });
  const startCalls = client.calls;
  for (const p of chosen) {
    if (client.calls - startCalls >= budget) break;
    const bundle = await fetchCompanyBundle(client, p.entity_id, chConfig);
    const { claims } = await mapCompanyBundle(bundle, run.run_id, chConfig);
    await ingestClaims(storage, ctx, { run_id: run.run_id, fetched_at: bundle.fetched_at }, claims);
    if (p.request_ids.length) await storage.verificationRequests.markProcessed(p.request_ids);
  }
  await storage.runs.finish(run.run_id, "succeeded");
  return {
    run_id: run.run_id,
    planned: plan.length,
    processed: chosen.length,
    calls: client.calls - startCalls,
  };
}
