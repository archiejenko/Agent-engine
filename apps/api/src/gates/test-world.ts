import { loadDecisionsConfig, loadInfraConfig } from "@ae/config";
import { needsYou } from "@ae/infra";
import type { Storage } from "@ae/storage";

/**
 * The test world (gates, screenshots, the phone layout test) loads fake Companies House files through
 * the normal pipeline, so its companies, opportunities and lead decisions carry no "simulated" flag
 * anywhere. Archie's choice at the U2 gate (option b): mark those leads as simulated in the test data
 * only. No migration, no guessing from company names. Never called on a real database.
 */
export async function markTestWorldLeadsSimulated(storage: Storage): Promise<number> {
  // Open the queue first (leads are opened lazily), so every lead the world has is marked.
  await needsYou({ storage, cfg: loadInfraConfig(), dcfg: loadDecisionsConfig() });
  const leads = (
    await storage.decisions.list({ status: "open", type: "lead", limit: 5000 })
  ).filter((d) => !d.synthetic);
  await storage.decisions.markSynthetic(leads.map((d) => d.id));
  return leads.length;
}
