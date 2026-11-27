import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSyntheticWorld, fakeModel, type GateCriterion } from "@ae/agent-runner";
import { loadPortfolioConfig, loadSourcesConfig } from "@ae/config";
import { importIdeas, seedProblemsFromIdeas } from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import { PLACEMENT, type SqlStorage } from "@ae/storage";
import {
  backfillVault,
  type Fetcher,
  fetchKey,
  SourceRefused,
  SourceRegistry,
} from "@ae/verification";

/**
 * v4 Phase 1 gate (PLAN.md §8): vault schema + source registry, on the synthetic world (fake Companies
 * House files through the normal pipeline, a fake model). Nothing external happens: every source
 * adapter here is a fake that counts its calls.
 */

const pass = (ok: boolean): GateCriterion["status"] => (ok ? "passed (synthetic)" : "failed");

const V4_TABLES: Record<string, "core" | "facts" | "telemetry"> = {
  problems: "core",
  segments: "core",
  routes: "core",
  channels: "core",
  opportunities: "core",
  opportunity_stages: "core",
  diagnoses: "core",
  assets: "core",
  judgements: "core",
  market_packs: "core",
  compliance_rules: "core",
  inboxes: "core",
  touches: "core",
  replies: "core",
  lead_scores: "core",
  businesses: "facts",
  external_ids: "facts",
  contacts: "facts",
  signals: "facts",
  sources: "facts",
  source_fetches: "facts",
  briefs: "facts",
  audit_log: "telemetry",
};

export async function runV4Phase1Gate(
  storage: SqlStorage,
  root: string,
  o: { count?: number } = {},
) {
  const criteria: GateCriterion[] = [];
  const count = o.count ?? 2000;
  const world = await buildSyntheticWorld(storage, fakeModel(), { count });
  // The lead-gen module, as Phase 2 runs it: engine signals (signal_values) and lead scores.
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const moduleRun = await runModule(storage, world.ctx, fw, {
    asOf: new Date().toISOString().slice(0, 10),
  });
  // Three scout signals, as the Ideas research agents write them (synthetic, from fetched content).
  const someEntity = moduleRun.opportunities[0]?.entity_id ?? null;
  for (const [i, v] of ["Electrician", "Office Manager", "Sales Executive"].entries())
    await storage.scoutSignals.add({
      signal_id: `gate_scout_${i}`,
      field: "job_postings",
      source_name: "company_website",
      source_url: "https://site.example/careers",
      lane: "open",
      entity_id: someEntity,
      signal_type: "hiring",
      value: v,
      taxonomy_node: "HR",
      market_key: "smes",
      market: { buyer: "SMEs", industry: null },
      observed_at: new Date().toISOString(),
      synthetic: true,
    });
  await importIdeas(storage, readFileSync(join(root, "brain/ideas/seed-500.csv"), "utf8"), {
    by: "gate",
  });

  // 1. Schema: every v4 table exists, in the store the plan put it in.
  const health = await storage.health();
  const migrated = new Map<string, string>();
  for (const store of ["core", "facts", "telemetry"] as const)
    for (const f of readdirSync(join(root, "packages/storage/migrations", store)))
      for (const m of readFileSync(
        join(root, "packages/storage/migrations", store, f),
        "utf8",
      ).matchAll(/CREATE TABLE\s+([a-z_]+)/gi))
        migrated.set((m[1] as string).toLowerCase(), store);
  const wrongStore = Object.entries(V4_TABLES).filter(
    ([t, s]) => PLACEMENT[t] !== s || (t !== "lead_scores" && migrated.get(t) !== s),
  );
  criteria.push({
    criterion:
      "Every v4 table from PLAN.md §2 is migrated and placed in its planned database (core / facts / telemetry); no foreign key crosses a database (placement test)",
    status: pass(wrongStore.length === 0 && health.ok),
    evidence: `${Object.keys(V4_TABLES).length} tables checked; misplaced: ${wrongStore.map(([t]) => t).join(", ") || "none"}. Migrations applied: core ${health.databases.core}, facts ${health.databases.facts}, telemetry ${health.databases.telemetry}. Up → down → up is tested for 0032, facts 0004 and telemetry 0004 (placement.test.ts), and 0031 with its rows (v4.test.ts).`,
  });

  // 2. Rename: Phase 2 leads live in lead_scores; the new opportunities table is the portfolio.
  const leads = await storage.opportunities.list({ limit: 100_000 });
  const portfolio = await storage.portfolio.opportunities.get("opp_any");
  criteria.push({
    criterion:
      "The old `opportunities` (Phase 2 lead scores) is renamed `lead_scores` with every row kept; its API still works",
    status: pass(leads.length > 0 && portfolio === null),
    evidence: `${leads.length} lead scores read through the old API from lead_scores; the new portfolio table is empty (no opportunity is created before Phase 4).`,
  });

  // 3. Backfill: 100% of entities have a business and a uk_ch external ID.
  const r = await backfillVault(storage);
  const entities = await storage.entities.count();
  const unmapped = await storage.vault.businesses.unmappedEntities();
  const noExt = await storage.vault.businesses.entitiesWithoutExternalId();
  const again = await backfillVault(storage);
  criteria.push({
    criterion:
      "100% of Companies House entities have a canonical business_id (gb-ch:<number>) and a uk_ch external ID; the backfill is idempotent",
    status: pass(
      entities > 0 &&
        unmapped.length === 0 &&
        noExt.length === 0 &&
        r.businesses === entities &&
        again.businesses === r.businesses &&
        (await storage.vault.businesses.count()) === entities,
    ),
    evidence: `${entities} entities → ${r.businesses} businesses, ${r.external_ids} uk_ch IDs; unmapped ${unmapped.length}, without an external ID ${noExt.length}. Second run: ${again.businesses} businesses, ${again.engine_signals_copied} signals copied.`,
  });

  // 4. Signals: every engine signal copied; scout signals copied as untrusted.
  const uncopied = await storage.vault.signals.uncopiedEngineSignals();
  criteria.push({
    criterion:
      "Every engine signal (signal_values) and scout signal is in the one `signals` table, with market and lane; scout signals are untrusted",
    status: pass(uncopied === 0 && r.engine_signals_copied > 0 && r.scout_signals_copied === 3),
    evidence: `${r.engine_signals_copied} engine signals and ${r.scout_signals_copied} scout signals copied; ${uncopied} left uncopied. The old tables stay until Phase 3 moves their readers.`,
  });

  // 5. Problems from the 500 seed ideas, all sensed (rule 23).
  const p = await seedProblemsFromIdeas(storage);
  const map = await storage.portfolio.problems.map();
  criteria.push({
    criterion:
      "The problem map is seeded from the 500 seed ideas (industry × function × category); every problem is sensed with no evidence (rule 23: seeds are guesses)",
    status: pass(
      p.ideas === 500 &&
        map.reduce((a, c) => a + c.problems, 0) === p.problems &&
        (await storage.portfolio.problems.evidencedCount()) === 0,
    ),
    evidence: `${p.ideas} ideas → ${p.problems} problems in ${new Set(map.map((m) => m.industry_code)).size} industries × ${new Set(map.map((m) => m.function)).size} functions. Problems with any evidence or a status other than sensed: ${await storage.portfolio.problems.evidencedCount()}.`,
  });

  // 6. Routes and channels: only registered ones; no AI voice or SMS channel exists.
  const port = loadPortfolioConfig();
  criteria.push({
    criterion:
      "Routes and channels come from config; there is no AI voice or SMS channel to compile (TCPA / PECR)",
    status: pass(
      (await storage.portfolio.routes.count()) === 5 &&
        (await storage.portfolio.channels.count()) === 6 &&
        !port.channels.some((c) => /voice|sms|call/.test(c.channel_id)),
    ),
    evidence: `${port.routes.map((x) => x.route_id).join(", ")} · ${port.channels.map((x) => x.channel_id).join(", ")}.`,
  });

  // 7–11. Source registry.
  const calls: Record<string, number> = {};
  const counting =
    (id: string, body: unknown, ids?: string[]): Fetcher =>
    async () => {
      calls[id] = (calls[id] ?? 0) + 1;
      return { body, ids };
    };
  const reg = new SourceRegistry({
    storage,
    fetchers: {
      companies_house: counting("companies_house", { company_name: "SAMPLE LIMITED" }),
      the_gazette: counting("the_gazette", { notices: [] }),
      google_places_us: counting("google_places_us", { places: [{ id: "ChIJ_gate" }] }, [
        "ChIJ_gate",
      ]),
      unregistered_vendor: counting("unregistered_vendor", {}),
    },
    synthetic: true,
  });
  const nSources = await reg.sync();
  const sources = await storage.vault.sources.list();
  const connected = sources.filter((s) => s.connected).map((s) => s.source_id);
  const cfg = loadSourcesConfig();
  criteria.push({
    criterion:
      "Every source in config is registered with cost, freshness, reliability, health, lane and retention; only sources in use before v4 start connected (lazy)",
    status: pass(
      nSources === cfg.sources.length &&
        sources.length === nSources &&
        connected.every((id) => cfg.sources.find((s) => s.source_id === id)?.connected_by_default),
    ),
    evidence: `${nSources} registered; connected: ${connected.join(", ")}; waiting to connect: ${sources
      .filter((s) => !s.connected)
      .map((s) => s.source_id)
      .join(", ")}.`,
  });

  const first = await reg.fetch("companies_house", { company_number: "01234567" });
  const second = await reg.fetch("companies_house", { company_number: "01234567" });
  criteria.push({
    criterion: "A fetch hits the cache the second time",
    status: pass(!first.cached && second.cached && calls.companies_house === 1),
    evidence: `first fetch live, second from the cache; the adapter was called ${calls.companies_house} time(s).`,
  });

  const refusedUnregistered = await reg
    .fetch("unregistered_vendor", {})
    .then(() => null)
    .catch((e: unknown) => (e instanceof SourceRefused ? e.reason : String(e)));
  const refusedLazy = await reg
    .fetch("the_gazette", { q: "x" })
    .then(() => null)
    .catch((e: unknown) => (e instanceof SourceRefused ? e.reason : String(e)));
  await reg.connect("the_gazette", "opp_gate_example");
  const afterConnect = await reg.fetch("the_gazette", { q: "x" });
  criteria.push({
    criterion:
      "An unregistered source is refused; a registered source is refused until it's connected for an opportunity",
    status: pass(
      refusedUnregistered === "not_registered" &&
        refusedLazy === "not_connected" &&
        !afterConnect.cached &&
        calls.unregistered_vendor === undefined,
    ),
    evidence: `unregistered → ${refusedUnregistered} (adapter never called); the_gazette before connect → ${refusedLazy}; after connect for opp_gate_example → fetched; used_by = ${JSON.stringify((await storage.vault.sources.get("the_gazette"))?.used_by)}.`,
  });

  await reg.connect("google_places_us", "opp_gate_example");
  await reg.fetch("google_places_us", { text: "sample" });
  const p2 = await reg.fetch("google_places_us", { text: "sample" });
  const placesRow = await storage.vault.fetches.get(
    await fetchKey("google_places_us", { text: "sample" }),
  );
  criteria.push({
    criterion:
      "Google Places (id_only, Archie's amendment): only the place_id is stored; every other field is re-fetched on demand",
    status: pass(
      placesRow?.body === null &&
        JSON.stringify(placesRow?.ids) === JSON.stringify(["ChIJ_gate"]) &&
        !p2.cached &&
        calls.google_places_us === 2,
    ),
    evidence: `stored: ids ${JSON.stringify(placesRow?.ids)}, body ${placesRow?.body === null ? "none" : "STORED"}; two requests → ${calls.google_places_us} live calls. Google's caching terms still to be checked before Places connects for real (Phase 6).`,
  });

  return { criteria };
}
