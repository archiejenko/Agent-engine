import type {
  AuditEntry,
  Business,
  Channel,
  ExternalId,
  Market,
  OpportunityRow,
  Problem,
  Route,
  Segment,
  SignalRow,
  SourceCostModel,
  SourceDefinition,
  SourceHealth,
  SourceRow,
} from "@ae/contracts";
import { type Bodies, bodyOf } from "./bodies.ts";
import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";

/**
 * v4 Phase 1 (PLAN.md §2): the vault (businesses, external IDs, contacts, signals, the source registry
 * and its fetch cache), the portfolio (problems, segments, routes, channels, opportunities) and the
 * audit log. Each table lives in one store (placement.ts); IDs that cross stores are plain text.
 */

const b = (v: boolean) => (v ? 1 : 0);
const j = (v: unknown) => JSON.stringify(v);
const parse = <T>(v: unknown, fallback: T): T =>
  typeof v === "string" && v !== "" ? (JSON.parse(v) as T) : fallback;

function insert(table: string, row: Record<string, SqlValue>, conflict: string = ""): SqlStatement {
  const cols = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${conflict ? ` ${conflict}` : ""}`,
    params: cols.map((c) => row[c] as SqlValue),
  };
}

export interface SourceFetchRow {
  fetch_key: string;
  source_id: string;
  request: unknown;
  fetched_at: string;
  expires_at: string;
  /** The stored response (JSON), or null: always null for an id_only source. */
  body: unknown | null;
  ids: string[];
  cost_gbp: number;
  status: "ok" | "error";
  schema_hash: string | null;
  hits: number;
  synthetic: boolean;
}

const sourceRow = (r: Record<string, unknown>): SourceRow => ({
  source_id: r.source_id as string,
  name: r.name as string,
  market: r.market as Market,
  region: (r.region as string | null) ?? null,
  kind: r.kind as SourceRow["kind"],
  tier: Number(r.tier),
  lane: r.lane as SourceRow["lane"],
  retention: r.retention as SourceRow["retention"],
  cost_model: parse<SourceCostModel>(r.cost_model, { kind: "free" }),
  freshness_target_h: Number(r.freshness_target_h),
  reliability: r.reliability == null ? null : Number(r.reliability),
  health: r.health as SourceHealth,
  schema_hash: (r.schema_hash as string | null) ?? null,
  connected: Number(r.connected) === 1,
  connected_at: (r.connected_at as string | null) ?? null,
  connected_for: (r.connected_for as string | null) ?? null,
  terms_url: (r.terms_url as string | null) ?? null,
  terms_checked_at: (r.terms_checked_at as string | null) ?? null,
  used_by: parse<string[]>(r.used_by, []),
  config_hash: r.config_hash as string,
  updated_at: r.updated_at as string,
});

const fetchRow = (r: Record<string, unknown>, body: unknown | null): SourceFetchRow => ({
  fetch_key: r.fetch_key as string,
  source_id: r.source_id as string,
  request: parse<unknown>(r.request, null),
  fetched_at: r.fetched_at as string,
  expires_at: r.expires_at as string,
  body,
  ids: parse<string[]>(r.ids, []),
  cost_gbp: Number(r.cost_gbp),
  status: r.status as "ok" | "error",
  schema_hash: (r.schema_hash as string | null) ?? null,
  hits: Number(r.hits),
  synthetic: Number(r.synthetic) === 1,
});

const businessRow = (r: Record<string, unknown>): Business => ({
  business_id: r.business_id as string,
  name: r.name as string,
  name_normalised: r.name_normalised as string,
  market: r.market as Market,
  region: (r.region as Business["region"]) ?? null,
  status: (r.status as string | null) ?? null,
  company_type: (r.company_type as string | null) ?? null,
  industry_code: (r.industry_code as string | null) ?? null,
  size_band: (r.size_band as string | null) ?? null,
  primary_domain: (r.primary_domain as string | null) ?? null,
  merged_into: (r.merged_into as string | null) ?? null,
  source_run_id: (r.source_run_id as string | null) ?? null,
});

const opportunityRow = (r: Record<string, unknown>): OpportunityRow => ({
  opportunity_id: r.opportunity_id as string,
  version: Number(r.version),
  problem_id: r.problem_id as string,
  segment_id: r.segment_id as string,
  route_id: r.route_id as OpportunityRow["route_id"],
  channel_id: r.channel_id as OpportunityRow["channel_id"],
  market: r.market as Market,
  region: (r.region as OpportunityRow["region"]) ?? null,
  stage: r.stage as OpportunityRow["stage"],
  bucket: r.bucket as OpportunityRow["bucket"],
  config: parse<Record<string, unknown>>(r.config, {}),
  config_hash: r.config_hash as string,
  compiled_graph: (r.compiled_graph as string | null) ?? null,
  lane: r.lane as OpportunityRow["lane"],
  parent_opportunity_id: (r.parent_opportunity_id as string | null) ?? null,
  hypothesis_id: (r.hypothesis_id as string | null) ?? null,
  status: r.status as OpportunityRow["status"],
  approval_id: (r.approval_id as string | null) ?? null,
  spend_gbp: Number(r.spend_gbp),
  revenue_gbp: Number(r.revenue_gbp),
  observed_cac_gbp: r.observed_cac_gbp == null ? null : Number(r.observed_cac_gbp),
  observed_cost_to_serve_gbp:
    r.observed_cost_to_serve_gbp == null ? null : Number(r.observed_cost_to_serve_gbp),
  synthetic: Number(r.synthetic) === 1,
});

const count = async (db: SqlDriver, sql: string, params: SqlValue[] = []) =>
  Number((await db.all<{ n: number }>(sql, params))[0]?.n ?? 0);

export function v4Storage(db: SqlDriver, bodies: Bodies) {
  const now = () => new Date().toISOString();
  return {
    vault: {
      businesses: {
        /** Insert or refresh many at once (one batch). Merges and the creation time are kept. */
        putMany: async (rows: Business[]): Promise<void> => {
          if (!rows.length) return;
          const at = now();
          await db.batch(
            rows.map((x) =>
              insert(
                "businesses",
                {
                  ...x,
                  created_at: at,
                  updated_at: at,
                } as unknown as Record<string, SqlValue>,
                `ON CONFLICT (business_id) DO UPDATE SET name = excluded.name, name_normalised = excluded.name_normalised,
                   region = excluded.region, status = excluded.status, company_type = excluded.company_type,
                   industry_code = COALESCE(excluded.industry_code, businesses.industry_code),
                   size_band = COALESCE(excluded.size_band, businesses.size_band),
                   primary_domain = COALESCE(excluded.primary_domain, businesses.primary_domain),
                   source_run_id = excluded.source_run_id, updated_at = excluded.updated_at`,
              ),
            ),
          );
        },
        get: async (id: string): Promise<Business | null> => {
          const [r] = await db.all("SELECT * FROM businesses WHERE business_id = ?", [id]);
          return r ? businessRow(r) : null;
        },
        count: (market?: Market) =>
          market
            ? count(db, "SELECT COUNT(*) AS n FROM businesses WHERE market = ?", [market])
            : count(db, "SELECT COUNT(*) AS n FROM businesses"),
        /** UK companies (entities) with no business row: should be none after the backfill. */
        unmappedEntities: async (): Promise<string[]> =>
          (
            await db.all<{ entity_id: string }>(
              `SELECT e.entity_id FROM entities e
               LEFT JOIN businesses bz ON bz.business_id = 'gb-ch:' || upper(e.entity_id)
               WHERE bz.business_id IS NULL ORDER BY e.entity_id`,
            )
          ).map((r) => r.entity_id),
        /** UK companies (entities) with no uk_ch external ID: should be none after the backfill. */
        entitiesWithoutExternalId: async (): Promise<string[]> =>
          (
            await db.all<{ entity_id: string }>(
              `SELECT e.entity_id FROM entities e
               LEFT JOIN external_ids x ON x.scheme = 'uk_ch' AND x.value = upper(e.entity_id)
               WHERE x.value IS NULL ORDER BY e.entity_id`,
            )
          ).map((r) => r.entity_id),
      },
      backfill: {
        /**
         * Every Companies House entity → a business row (same store, one statement). The industry comes
         * from the first SIC code's division via the industry list; the region from the LAD code.
         * Returns the number of businesses that exist for entities afterwards.
         */
        businessesFromEntities: async (
          at: string,
          industries: { industries: { code: string; sic_divisions: string[] }[] },
        ): Promise<number> => {
          const cases: string[] = [];
          const params: SqlValue[] = [];
          for (const i of industries.industries)
            if (i.sic_divisions.length) {
              cases.push(`WHEN div IN (${i.sic_divisions.map(() => "?").join(", ")}) THEN ?`);
              params.push(...i.sic_divisions, i.code);
            }
          const industryCase = cases.length ? `CASE ${cases.join(" ")} ELSE NULL END` : "NULL";
          await db.run(
            `WITH e AS (
               SELECT entity_id, name, name_normalised, lad_code, company_status, source_run_id,
                 substr(json_extract(sic_codes, '$[0]'), 1, 2) AS div FROM entities
             )
             INSERT INTO businesses (business_id, name, name_normalised, market, region, status, company_type,
               industry_code, size_band, primary_domain, merged_into, source_run_id, created_at, updated_at)
             SELECT 'gb-ch:' || upper(entity_id), name, name_normalised, 'UK',
               CASE substr(lad_code, 1, 1) WHEN 'E' THEN 'ENG' WHEN 'W' THEN 'WAL' WHEN 'S' THEN 'SCO' WHEN 'N' THEN 'NIR' END,
               company_status, NULL, ${industryCase}, NULL, NULL, NULL, source_run_id, ?, ?
             FROM e WHERE true
             ON CONFLICT (business_id) DO UPDATE SET name = excluded.name, name_normalised = excluded.name_normalised,
               region = excluded.region, status = excluded.status,
               industry_code = COALESCE(excluded.industry_code, businesses.industry_code),
               source_run_id = excluded.source_run_id, updated_at = excluded.updated_at`,
            [...params, at, at],
          );
          return count(
            db,
            "SELECT COUNT(*) AS n FROM businesses b JOIN entities e ON b.business_id = 'gb-ch:' || upper(e.entity_id)",
          );
        },
        /** Every entity → its uk_ch external ID (source: the bulk file it came from). */
        externalIdsFromEntities: async (): Promise<number> => {
          await db.run(
            `INSERT INTO external_ids (business_id, scheme, value, source_id, confidence, fetched_at)
             SELECT 'gb-ch:' || upper(entity_id), 'uk_ch', upper(entity_id), 'companies_house_bulk', 1.0, updated_at
             FROM entities WHERE true ON CONFLICT (scheme, value) DO NOTHING`,
          );
          return count(db, "SELECT COUNT(*) AS n FROM external_ids WHERE scheme = 'uk_ch'");
        },
      },
      externalIds: {
        putMany: async (rows: ExternalId[]): Promise<void> => {
          if (!rows.length) return;
          await db.batch(
            rows.map((x) =>
              insert(
                "external_ids",
                x as unknown as Record<string, SqlValue>,
                `ON CONFLICT (scheme, value) DO UPDATE SET business_id = excluded.business_id,
                   source_id = excluded.source_id, confidence = excluded.confidence, fetched_at = excluded.fetched_at`,
              ),
            ),
          );
        },
        /** The business an external ID belongs to, if any. */
        resolve: async (scheme: string, value: string): Promise<string | null> => {
          const [r] = await db.all<{ business_id: string }>(
            "SELECT business_id FROM external_ids WHERE scheme = ? AND value = ?",
            [scheme, value],
          );
          return r?.business_id ?? null;
        },
        forBusiness: async (businessId: string): Promise<ExternalId[]> =>
          (
            await db.all<Record<string, unknown>>(
              "SELECT * FROM external_ids WHERE business_id = ? ORDER BY scheme, value",
              [businessId],
            )
          ).map((r) => ({
            business_id: r.business_id as string,
            scheme: r.scheme as ExternalId["scheme"],
            value: r.value as string,
            source_id: r.source_id as string,
            confidence: Number(r.confidence),
            fetched_at: r.fetched_at as string,
          })),
      },
      signals: {
        putMany: async (rows: SignalRow[]): Promise<void> => {
          if (!rows.length) return;
          await db.batch(
            rows.map((s) =>
              insert(
                "signals",
                {
                  ...s,
                  fact_ids: j(s.fact_ids),
                  untrusted: b(s.untrusted),
                  synthetic: b(s.synthetic),
                } as unknown as Record<string, SqlValue>,
                "ON CONFLICT (signal_key) DO NOTHING",
              ),
            ),
          );
        },
        count: async (kind?: SignalRow["kind"]) =>
          kind
            ? count(db, "SELECT COUNT(*) AS n FROM signals WHERE kind = ?", [kind])
            : count(db, "SELECT COUNT(*) AS n FROM signals"),
        /** Old engine signal rows (signal_values) not yet copied: should be none after the backfill. */
        uncopiedEngineSignals: () =>
          count(
            db,
            `SELECT COUNT(*) AS n FROM signal_values v
             WHERE NOT EXISTS (SELECT 1 FROM signals s WHERE s.signal_key =
               'engine:' || v.signal_id || '@' || v.signal_version || ':' || v.entity_id || ':' || v.as_of)`,
          ),
        /** Copy every engine signal (signal_values) into signals. Same store, one statement. */
        copyEngineSignals: async (): Promise<number> =>
          (
            await db.run(
              `INSERT INTO signals (signal_key, kind, definition_id, definition_version, business_id, problem_id, value,
                 fact_ids, source_id, untrusted, market, region, observed_at, valid_from, lane, run_id, synthetic)
               SELECT 'engine:' || signal_id || '@' || signal_version || ':' || entity_id || ':' || as_of, 'engine',
                 signal_id, signal_version, 'gb-ch:' || upper(entity_id), NULL,
                 CASE WHEN value IS NULL THEN NULL ELSE CAST(value AS TEXT) END,
                 fact_ids, NULL, 0, 'UK', NULL, as_of, as_of, 'open', run_id, 0
               FROM signal_values WHERE true ON CONFLICT (signal_key) DO NOTHING`,
            )
          ).changes,
      },
      sources: {
        /**
         * Register sources from config. Definition fields follow the config; runtime state (connected,
         * health, schema hash, used_by) is kept.
         */
        sync: async (defs: (SourceDefinition & { config_hash: string })[]): Promise<void> => {
          if (!defs.length) return;
          const at = now();
          await db.batch(
            defs.map((d) =>
              insert(
                "sources",
                {
                  source_id: d.source_id,
                  name: d.name,
                  market: d.market,
                  region: d.region,
                  kind: d.kind,
                  tier: d.tier,
                  lane: d.lane,
                  retention: d.retention,
                  cost_model: j(d.cost_model),
                  freshness_target_h: d.freshness_target_h,
                  reliability: d.reliability,
                  connected: b(d.connected_by_default),
                  connected_at: d.connected_by_default ? at : null,
                  connected_for: d.connected_by_default ? "in use before v4" : null,
                  terms_url: d.terms_url,
                  terms_checked_at: d.terms_checked_at,
                  config_hash: d.config_hash,
                  updated_at: at,
                },
                `ON CONFLICT (source_id) DO UPDATE SET name = excluded.name, market = excluded.market,
                   region = excluded.region, kind = excluded.kind, tier = excluded.tier, lane = excluded.lane,
                   retention = excluded.retention, cost_model = excluded.cost_model,
                   freshness_target_h = excluded.freshness_target_h,
                   reliability = COALESCE(sources.reliability, excluded.reliability),
                   terms_url = excluded.terms_url, terms_checked_at = excluded.terms_checked_at,
                   config_hash = excluded.config_hash, updated_at = excluded.updated_at`,
              ),
            ),
          );
        },
        get: async (id: string): Promise<SourceRow | null> => {
          const [r] = await db.all("SELECT * FROM sources WHERE source_id = ?", [id]);
          return r ? sourceRow(r) : null;
        },
        list: async (market?: Market): Promise<SourceRow[]> =>
          (market
            ? await db.all("SELECT * FROM sources WHERE market = ? ORDER BY source_id", [market])
            : await db.all("SELECT * FROM sources ORDER BY source_id")
          ).map(sourceRow),
        /** Connect lazily, for one opportunity (or a named reason); records who uses it. */
        connect: async (id: string, forWhat: string): Promise<void> => {
          const s = await db.all<{ used_by: string; connected: number }>(
            "SELECT used_by, connected FROM sources WHERE source_id = ?",
            [id],
          );
          if (!s[0]) throw new Error(`source ${id} isn't registered`);
          const used = new Set(parse<string[]>(s[0].used_by, []));
          used.add(forWhat);
          const at = now();
          await db.run(
            `UPDATE sources SET connected = 1, connected_at = COALESCE(connected_at, ?),
               connected_for = COALESCE(connected_for, ?), used_by = ?, updated_at = ? WHERE source_id = ?`,
            [at, forWhat, j([...used].sort()), at, id],
          );
        },
        setHealth: async (id: string, health: SourceHealth, schemaHash?: string | null) => {
          await db.run(
            `UPDATE sources SET health = ?, schema_hash = COALESCE(?, schema_hash), updated_at = ? WHERE source_id = ?`,
            [health, schemaHash ?? null, now(), id],
          );
        },
        setSchemaHash: async (id: string, schemaHash: string) => {
          await db.run("UPDATE sources SET schema_hash = ?, updated_at = ? WHERE source_id = ?", [
            schemaHash,
            now(),
            id,
          ]);
        },
      },
      fetches: {
        get: async (key: string): Promise<SourceFetchRow | null> => {
          const [r] = await db.all("SELECT * FROM source_fetches WHERE fetch_key = ?", [key]);
          if (!r) return null;
          const stored = r.body !== null || r.body_key !== null;
          return fetchRow(r, stored ? JSON.parse(await bodies.text(bodyOf(r, "body"))) : null);
        },
        put: async (f: Omit<SourceFetchRow, "hits">): Promise<void> => {
          const body =
            f.body === null ? null : await bodies.put("source_fetch", f.fetch_key, j(f.body));
          const { body: _, ...rest } = f;
          const st = insert(
            "source_fetches",
            {
              ...rest,
              request: j(f.request),
              ids: j(f.ids),
              synthetic: b(f.synthetic),
              hits: 0,
              body: body ? body.inline : null,
              body_key: body?.key ?? null,
              body_size: body?.size ?? null,
              body_sha256: body?.sha256 ?? null,
            } as unknown as Record<string, SqlValue>,
            `ON CONFLICT (fetch_key) DO UPDATE SET fetched_at = excluded.fetched_at, expires_at = excluded.expires_at,
               body = excluded.body, body_key = excluded.body_key, body_size = excluded.body_size,
               body_sha256 = excluded.body_sha256, ids = excluded.ids, cost_gbp = excluded.cost_gbp,
               status = excluded.status, schema_hash = excluded.schema_hash`,
          );
          await db.run(st.sql, st.params);
        },
        hit: async (key: string) => {
          await db.run("UPDATE source_fetches SET hits = hits + 1 WHERE fetch_key = ?", [key]);
        },
        stats: async (sourceId: string) => {
          const [r] = await db.all<{ fetches: number; hits: number; cost: number }>(
            `SELECT COUNT(*) AS fetches, COALESCE(SUM(hits), 0) AS hits, COALESCE(SUM(cost_gbp), 0) AS cost
             FROM source_fetches WHERE source_id = ?`,
            [sourceId],
          );
          return {
            fetches: Number(r?.fetches ?? 0),
            hits: Number(r?.hits ?? 0),
            cost_gbp: Number(r?.cost ?? 0),
          };
        },
      },
    },

    portfolio: {
      problems: {
        putMany: async (rows: Problem[]): Promise<void> => {
          if (!rows.length) return;
          const at = now();
          await db.batch(
            rows.map((p) =>
              insert(
                "problems",
                {
                  ...p,
                  evidence_fact_ids: j(p.evidence_fact_ids),
                  markets_seen: j(p.markets_seen),
                  seed_hypothesis_ids: j(p.seed_hypothesis_ids),
                  synthetic: b(p.synthetic),
                  first_seen_at: at,
                  updated_at: at,
                } as unknown as Record<string, SqlValue>,
                `ON CONFLICT (problem_id) DO UPDATE SET statement = excluded.statement,
                   seed_hypothesis_ids = excluded.seed_hypothesis_ids, updated_at = excluded.updated_at`,
              ),
            ),
          );
        },
        count: () => count(db, "SELECT COUNT(*) AS n FROM problems"),
        /** Problems with any evidence or a status other than sensed (seeds must have none: rule 23). */
        evidencedCount: () =>
          count(
            db,
            "SELECT COUNT(*) AS n FROM problems WHERE status <> 'sensed' OR evidence_strength <> 0 OR evidence_fact_ids <> '[]'",
          ),
        /** Problems per industry × function: the mood board's cells. */
        map: async (): Promise<{ industry_code: string; function: string; problems: number }[]> =>
          (
            await db.all<{ industry_code: string; function: string; problems: number }>(
              `SELECT industry_code, function, COUNT(*) AS problems FROM problems
               WHERE status <> 'retired' GROUP BY industry_code, function ORDER BY industry_code, function`,
            )
          ).map((r) => ({ ...r, problems: Number(r.problems) })),
      },
      segments: {
        put: async (s: Segment): Promise<void> => {
          await db.run(
            `INSERT INTO segments (segment_id, market, region, industry_code, size_band, filters, est_population, population_source, as_of, synthetic)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (segment_id) DO UPDATE SET filters = excluded.filters, est_population = excluded.est_population,
               population_source = excluded.population_source, as_of = excluded.as_of`,
            [
              s.segment_id,
              s.market,
              s.region,
              s.industry_code,
              s.size_band,
              j(s.filters),
              s.est_population,
              s.population_source,
              s.as_of,
              b(s.synthetic),
            ],
          );
        },
      },
      routes: {
        sync: async (rows: Route[]): Promise<void> => {
          await db.batch(
            rows.map((r) =>
              insert(
                "routes",
                {
                  ...r,
                  default_stage_caps: j(r.default_stage_caps),
                  cost_to_serve_model: j(r.cost_to_serve_model),
                } as unknown as Record<string, SqlValue>,
                `ON CONFLICT (route_id) DO UPDATE SET template_graph = excluded.template_graph,
                   default_stage_caps = excluded.default_stage_caps,
                   cost_to_serve_model = excluded.cost_to_serve_model, status = excluded.status`,
              ),
            ),
          );
        },
        count: () => count(db, "SELECT COUNT(*) AS n FROM routes"),
      },
      channels: {
        sync: async (rows: Channel[]): Promise<void> => {
          await db.batch(
            rows.map((c) =>
              insert(
                "channels",
                {
                  ...c,
                  allowed_markets: j(c.allowed_markets),
                  compliance_pack_ids: j(c.compliance_pack_ids),
                } as unknown as Record<string, SqlValue>,
                `ON CONFLICT (channel_id) DO UPDATE SET template_graph = excluded.template_graph,
                   allowed_markets = excluded.allowed_markets,
                   compliance_pack_ids = excluded.compliance_pack_ids, status = excluded.status`,
              ),
            ),
          );
        },
        count: () => count(db, "SELECT COUNT(*) AS n FROM channels"),
      },
      opportunities: {
        /** A new version of an opportunity. Versions are never edited (a changed config is a new contract). */
        add: async (o: OpportunityRow): Promise<void> => {
          const at = now();
          const st = insert("opportunities", {
            ...o,
            config: j(o.config),
            synthetic: b(o.synthetic),
            created_at: at,
            updated_at: at,
          } as unknown as Record<string, SqlValue>);
          await db.run(st.sql, st.params);
        },
        get: async (id: string, version?: number): Promise<OpportunityRow | null> => {
          const [r] = version
            ? await db.all("SELECT * FROM opportunities WHERE opportunity_id = ? AND version = ?", [
                id,
                version,
              ])
            : await db.all(
                "SELECT * FROM opportunities WHERE opportunity_id = ? ORDER BY version DESC LIMIT 1",
                [id],
              );
          return r ? opportunityRow(r) : null;
        },
      },
    },

    auditLog: {
      /** Append only: there is no update or delete. */
      append: async (e: AuditEntry): Promise<void> => {
        const row = {
          ...e,
          source_ids: j(e.source_ids),
          fact_ids: j(e.fact_ids),
          dry_run: b(e.dry_run),
          synthetic: b(e.synthetic),
        } as unknown as Record<string, SqlValue>;
        const s = insert("audit_log", row);
        await db.run(s.sql, s.params);
      },
      count: () => count(db, "SELECT COUNT(*) AS n FROM audit_log"),
    },
  };
}

export type V4Storage = ReturnType<typeof v4Storage>;
