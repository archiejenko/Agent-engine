import { type InfraConfig, loadInfraConfig, loadModelsConfig, type ModelsConfig } from "@ae/config";
import type { UniverseConfig } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "../../context.ts";
import { ingestClaims } from "../../ingest.ts";
import { type CostMode, meteredModel, withFallback, withMeter } from "../../metered-model.ts";
import { dailyCapProblems } from "../../spend-caps.ts";
import { collectWebsiteClaims, type WebsitePorts } from "./ingest.ts";

/** Cost labels for the website extractor's model calls. */
export const WEBSITE_PLAYBOOK = "website_ingest";
export const WEBSITE_STEP = "website_extract";

/** Website ingestion for every universe member (or the first `limit`). Model usage is reported back. */
export async function ingestWebsites(
  storage: Storage,
  ctx: VerificationContext,
  universe: UniverseConfig,
  ports: WebsitePorts,
  o: {
    limit?: number;
    onModelUsage?: (
      entityId: string,
      usage: { input_tokens: number; output_tokens: number; model: string },
    ) => Promise<void>;
    log?: (m: string) => void;
    /** Prices for the cost ledger (default: packages/config). */
    models?: ModelsConfig;
    /** Cost mode (default "live"). A sandbox building its own world passes "sandbox". */
    costMode?: CostMode;
    /** Spend caps (default: packages/config infra.json). */
    caps?: InfraConfig["caps"];
    now?: () => Date;
  } = {},
) {
  const run = await storage.runs.start({ kind: "websites" });
  // Every extraction call writes one cost event (and its daily rollup) as it returns, like every
  // agent call (data layer plan, follow-up). A real model call is real money: live, never dry run.
  // The fake model's calls are marked synthetic.
  const md = { storage, models: o.models ?? loadModelsConfig() };
  // With a fallback model (Gemini 4 Hydrogen first, Claude on failure), each side is metered on its
  // own, so every attempt is on the ledger.
  const extractor = ports.fallbackModel
    ? withFallback(meteredModel(ports.model, md), meteredModel(ports.fallbackModel, md), {
        onFallback: () => {
          stats.extractor_fallbacks++;
        },
      })
    : meteredModel(ports.model, md);
  const metered: WebsitePorts = {
    ...ports,
    model: withMeter(extractor, {
      playbook: WEBSITE_PLAYBOOK,
      step_id: WEBSITE_STEP,
      run_id: run.run_id,
      mode: o.costMode ?? "live",
    }),
  };
  const members = (await storage.universe.list(universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const targets = o.limit ? members.slice(0, o.limit) : members;
  const stats = {
    companies: 0,
    found: 0,
    quarantined: 0,
    claims: 0,
    rejected_extractions: 0,
    /** Pages the extractor sent to the fallback model after the primary failed twice. */
    extractor_fallbacks: 0,
    /** Pages cut to the per-page token budget (each one recorded in page_cuts). */
    pages_cut: 0,
    /** Why the run stopped early (a daily spend cap), or null. */
    stopped: null as string | null,
  };
  const caps = o.caps ?? loadInfraConfig().caps;
  try {
    for (const id of targets) {
      const entity = await storage.entities.get(id);
      if (!entity) continue;
      // Guardrail 6, the same daily check the agent playbooks use, before every extraction call: the
      // call that crossed a cap is already on the ledger (metered at call time); the next one never
      // runs. Real money only, so a rehearsal on the fake model can't trip it; never sandbox spend.
      const over = await dailyCapProblems(storage, caps, WEBSITE_PLAYBOOK, {
        realOnly: true,
        ...(o.now ? { now: o.now() } : {}),
      });
      if (over.length) {
        stats.stopped = over.join(", ");
        await storage.alerts.raise("spend_cap", `Website ingestion stopped: ${stats.stopped}`, {
          playbook: WEBSITE_PLAYBOOK,
          run_id: run.run_id,
          companies_done: stats.companies,
        });
        o.log?.(`websites: stopped at ${stats.companies} companies (${stats.stopped})`);
        break;
      }
      const r = await collectWebsiteClaims(entity, metered, run.run_id, storage);
      for (const c of r.page_cuts) {
        stats.pages_cut++;
        await storage.pageCuts.record({
          run_id: run.run_id,
          entity_id: id,
          url: c.url,
          original_tokens: c.original_tokens,
          kept_tokens: c.kept_tokens,
          cut_at: new Date().toISOString(),
        });
      }
      stats.companies++;
      if (r.quarantined) stats.quarantined++;
      if (r.claims.some((c) => c.field === "website_found" && c.value === true)) stats.found++;
      stats.rejected_extractions += r.rejected_extractions.length;
      if (r.model_usage && o.onModelUsage) await o.onModelUsage(id, r.model_usage);
      if (r.claims.length) {
        await ingestClaims(
          storage,
          ctx,
          { run_id: run.run_id, fetched_at: r.claims[0]?.fetched_at as string },
          r.claims,
        );
        stats.claims += r.claims.length;
      }
      if (stats.companies % 500 === 0) o.log?.(`websites: ${stats.companies} done`);
    }
    await storage.runs.finish(run.run_id, "succeeded");
  } catch (e) {
    await storage.runs.finish(run.run_id, "failed");
    throw e;
  }
  return { run_id: run.run_id, ...stats };
}
