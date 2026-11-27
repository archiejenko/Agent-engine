import { configVersion, loadSourcesConfig, type SourcesConfig } from "@ae/config";
import type { SourceRow } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { canonicalJson } from "../ids.ts";

/**
 * The source registry (v4 Phase 1, PLAN.md §2.2). Every fetch from an outside source goes through here:
 * - only registered sources (config `sources.json`) can be fetched, and only once connected;
 * - sources connect lazily, for a named opportunity, never in bulk;
 * - results are cached in `source_fetches` (bodies through the storage body helper: inline or R2) until
 *   the source's freshness target;
 * - `id_only` sources (Google Places: Archie, 2026-11-27) never have a body stored: only the IDs are
 *   kept, and every other field is fetched live each time;
 * - a change in a source's response shape (schema hash) marks it `schema_drift` and stops fetches
 *   until it's looked at (the Phase 2 circuit breaker builds on this);
 * - a fetch that costs money writes a cost event at call time.
 */

export class SourceRefused extends Error {
  constructor(
    readonly source_id: string,
    readonly reason: "not_registered" | "not_connected" | "paused" | "schema_drift",
    message: string,
  ) {
    super(message);
    this.name = "SourceRefused";
  }
}

/** What a source adapter returns for one request. */
export interface FetchResult {
  /** The response. Never stored for an id_only source. */
  body: unknown;
  /** IDs in the response (e.g. place IDs): the only thing an id_only source keeps. */
  ids?: string[];
  /** A fingerprint of the response's shape (field names and types), for drift detection. */
  schema_hash?: string;
}

export type Fetcher = (request: Record<string, unknown>) => Promise<FetchResult>;

export interface Fetched {
  source_id: string;
  body: unknown;
  ids: string[];
  /** true when served from the cache (never true for an id_only source's body). */
  cached: boolean;
  fetched_at: string;
  cost_gbp: number;
}

export interface RegistryDeps {
  storage: Storage;
  fetchers: Record<string, Fetcher>;
  now?: () => Date;
  config?: SourcesConfig;
  synthetic?: boolean;
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const fetchKey = (sourceId: string, request: Record<string, unknown>) =>
  sha256(`${sourceId}\n${canonicalJson(request)}`);

/** A response's shape: field names and value types, recursively (values ignored). */
export function shapeOf(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]),
    );
  return v === null ? "null" : typeof v;
}
export const schemaHashOf = (v: unknown) => sha256(canonicalJson(shapeOf(v)));

const callCost = (s: SourceRow) => (s.cost_model.kind === "per_call" ? s.cost_model.gbp : 0);

export class SourceRegistry {
  private readonly now: () => Date;
  constructor(private readonly d: RegistryDeps) {
    this.now = d.now ?? (() => new Date());
  }

  /** Register (or refresh) every source in config. Runtime state is kept. */
  async sync(): Promise<number> {
    const cfg = this.d.config ?? loadSourcesConfig();
    const defs = await Promise.all(
      cfg.sources.map(async (s) => ({ ...s, config_hash: await configVersion(s) })),
    );
    await this.d.storage.vault.sources.sync(defs);
    return defs.length;
  }

  private async registered(sourceId: string): Promise<SourceRow> {
    const s = await this.d.storage.vault.sources.get(sourceId);
    if (!s)
      throw new SourceRefused(
        sourceId,
        "not_registered",
        `source ${sourceId} isn't in the source registry (packages/config/src/sources.json)`,
      );
    return s;
  }

  /** Connect a source lazily, for one approved opportunity (or a named job). */
  async connect(sourceId: string, forWhat: string): Promise<void> {
    await this.registered(sourceId);
    if (!forWhat.trim()) throw new Error("connect needs a reason: the opportunity it's for");
    await this.d.storage.vault.sources.connect(sourceId, forWhat);
  }

  async fetch(
    sourceId: string,
    request: Record<string, unknown>,
    ctx: { opportunity_id?: string | null; run_id?: string | null } = {},
  ): Promise<Fetched> {
    const s = await this.registered(sourceId);
    if (!s.connected)
      throw new SourceRefused(
        sourceId,
        "not_connected",
        `source ${sourceId} isn't connected: it connects only when an approved opportunity needs it`,
      );
    if (s.health === "paused" || s.health === "schema_drift")
      throw new SourceRefused(sourceId, s.health, `source ${sourceId} is ${s.health}`);
    const fetcher = this.d.fetchers[sourceId];
    if (!fetcher) throw new Error(`no adapter for source ${sourceId}`);

    const key = await fetchKey(sourceId, request);
    const nowD = this.now();
    const cached = await this.d.storage.vault.fetches.get(key);
    const fresh = cached && cached.status === "ok" && cached.expires_at > nowD.toISOString();
    if (fresh && s.retention === "full" && cached.body !== null) {
      await this.d.storage.vault.fetches.hit(key);
      return {
        source_id: sourceId,
        body: cached.body,
        ids: cached.ids,
        cached: true,
        fetched_at: cached.fetched_at,
        cost_gbp: 0,
      };
    }

    // Live fetch (always, for an id_only source: its fields are never served from storage).
    const res = await fetcher(request);
    const at = nowD.toISOString();
    const hash = res.schema_hash ?? (await schemaHashOf(res.body));
    if (s.schema_hash && s.schema_hash !== hash) {
      await this.d.storage.vault.sources.setHealth(sourceId, "schema_drift");
      throw new SourceRefused(
        sourceId,
        "schema_drift",
        `source ${sourceId} changed its response shape; fetches stop until it's checked`,
      );
    }
    if (!s.schema_hash) await this.d.storage.vault.sources.setSchemaHash(sourceId, hash);

    const cost = callCost(s);
    await this.d.storage.vault.fetches.put({
      fetch_key: key,
      source_id: sourceId,
      request,
      fetched_at: at,
      expires_at: new Date(nowD.getTime() + s.freshness_target_h * 3_600_000).toISOString(),
      body: s.retention === "full" ? res.body : null,
      ids: res.ids ?? [],
      cost_gbp: cost,
      status: "ok",
      schema_hash: hash,
      synthetic: this.d.synthetic ?? false,
    });
    if (cost > 0)
      await this.d.storage.costEvents.add({
        event_id: crypto.randomUUID(),
        at,
        run_id: ctx.run_id ?? null,
        graph_id: null,
        graph_version: null,
        node_id: null,
        task_id: null,
        opportunity_id: ctx.opportunity_id ?? null,
        revenue_path: null,
        shape_fingerprint: null,
        mode: "live",
        category: "third_party",
        unit: `source_call:${sourceId}`,
        quantity: 1,
        unit_price_gbp: cost,
        amount_gbp: cost,
        price_table_version: `sources@${s.config_hash}`,
        synthetic: this.d.synthetic ?? false,
        dry_run: false,
      });
    return {
      source_id: sourceId,
      body: res.body,
      ids: res.ids ?? [],
      cached: false,
      fetched_at: at,
      cost_gbp: cost,
    };
  }
}
