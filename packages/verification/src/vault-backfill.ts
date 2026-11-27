import { loadIdeaCategoriesConfig, loadIndustriesConfig, loadPortfolioConfig } from "@ae/config";
import type { IndustriesConfig, Problem, SignalRow } from "@ae/contracts";
import type { Storage } from "@ae/storage";

/**
 * v4 Phase 1 backfill (PLAN.md §8 Phase 1, step 3 and 5). Idempotent: run it again and nothing changes.
 * - Every Companies House entity → a business (`gb-ch:<number>`) and a `uk_ch` external ID.
 * - Engine signals (signal_values) and scout signals (scout_signals) → the one `signals` table.
 *   The old tables stay and are still read by their code until Phase 3 moves the readers.
 * - Problems are seeded separately, from the idea backlog (packages/infra/src/problems.ts): code here
 *   never reads it (rule 23).
 * - Routes and channels from config.
 */

export interface BackfillReport {
  businesses: number;
  external_ids: number;
  engine_signals_copied: number;
  scout_signals_copied: number;
  routes: number;
  channels: number;
}

/** UK nation from an ONS local authority code (E…/W…/S…/N…). */
export const nationOfLad = (lad: string | null) =>
  lad?.startsWith("E")
    ? "ENG"
    : lad?.startsWith("W")
      ? "WAL"
      : lad?.startsWith("S")
        ? "SCO"
        : lad?.startsWith("N")
          ? "NIR"
          : null;

/** The industry of a UK company from its first SIC code (two-digit division), or null. */
export function industryOfSic(sic: string[], cfg: IndustriesConfig): string | null {
  const div = sic[0]?.slice(0, 2);
  if (!div) return null;
  return cfg.industries.find((i) => i.sic_divisions.includes(div))?.code ?? null;
}

export async function backfillVault(
  storage: Storage,
  o: { now?: () => Date; industries?: IndustriesConfig } = {},
): Promise<BackfillReport> {
  const at = (o.now?.() ?? new Date()).toISOString();
  const industries = o.industries ?? loadIndustriesConfig();

  // 1. Businesses + external IDs, from entities (facts store; one statement each).
  const businesses = await storage.vault.backfill.businessesFromEntities(at, industries);
  const external_ids = await storage.vault.backfill.externalIdsFromEntities();

  // 2. Signals.
  const engine_signals_copied = await storage.vault.signals.copyEngineSignals();
  const scouts = await storage.scoutSignals.list(100_000);
  const rows: SignalRow[] = scouts.map((s) => ({
    signal_key: `scout:${s.signal_id}`,
    kind: "scout",
    definition_id: s.signal_type,
    definition_version: 0,
    business_id: s.entity_id ? `gb-ch:${s.entity_id}` : null,
    problem_id: null,
    value: typeof s.value === "string" ? s.value : JSON.stringify(s.value),
    fact_ids: [],
    source_id: s.source_name,
    untrusted: true,
    market: "UK",
    region: null,
    observed_at: s.observed_at,
    valid_from: s.observed_at,
    lane: s.lane,
    run_id: null,
    synthetic: s.synthetic,
  }));
  await storage.vault.signals.putMany(rows);

  // 3. Routes and channels.
  const port = loadPortfolioConfig();
  await storage.portfolio.routes.sync(port.routes);
  await storage.portfolio.channels.sync(port.channels);

  return {
    businesses,
    external_ids,
    engine_signals_copied,
    scout_signals_copied: rows.length,
    routes: port.routes.length,
    channels: port.channels.length,
  };
}
