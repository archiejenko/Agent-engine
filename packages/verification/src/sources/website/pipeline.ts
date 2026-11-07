import type { UniverseConfig } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "../../context.ts";
import { ingestClaims } from "../../ingest.ts";
import { collectWebsiteClaims, type WebsitePorts } from "./ingest.ts";

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
  } = {},
) {
  const run = await storage.runs.start({ kind: "websites" });
  const members = (await storage.universe.list(universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const targets = o.limit ? members.slice(0, o.limit) : members;
  const stats = { companies: 0, found: 0, quarantined: 0, claims: 0, rejected_extractions: 0 };
  try {
    for (const id of targets) {
      const entity = await storage.entities.get(id);
      if (!entity) continue;
      const r = await collectWebsiteClaims(entity, ports, run.run_id, storage);
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
