import { loadModelsConfig, type ModelsConfig } from "@ae/config";
import type { UniverseConfig } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "../../context.ts";
import { ingestClaims } from "../../ingest.ts";
import { type CostMode, meteredModel, withMeter } from "../../metered-model.ts";
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
  } = {},
) {
  const run = await storage.runs.start({ kind: "websites" });
  // Every extraction call writes one cost event (and its daily rollup) as it returns, like every
  // agent call (data layer plan, follow-up). A real model call is real money: live, never dry run.
  // The fake model's calls are marked synthetic.
  const metered: WebsitePorts = {
    ...ports,
    model: withMeter(
      meteredModel(ports.model, { storage, models: o.models ?? loadModelsConfig() }),
      {
        playbook: WEBSITE_PLAYBOOK,
        step_id: WEBSITE_STEP,
        run_id: run.run_id,
        mode: o.costMode ?? "live",
      },
    ),
  };
  const members = (await storage.universe.list(universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const targets = o.limit ? members.slice(0, o.limit) : members;
  const stats = { companies: 0, found: 0, quarantined: 0, claims: 0, rejected_extractions: 0 };
  try {
    for (const id of targets) {
      const entity = await storage.entities.get(id);
      if (!entity) continue;
      const r = await collectWebsiteClaims(entity, metered, run.run_id, storage);
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
