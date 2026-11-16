import type { TriggerRule, TriggersConfig } from "@ae/config";
import type { Storage } from "@ae/storage";

/**
 * Reactive triggers (v2 Phase 2). Change events (from the change feed, or from polling when the feed is
 * down) go through a cheap deterministic filter: kind, company scope and field matches. Only a matched
 * event acts, and only a rule marked `model: true` may call the model, so a burst of 1,000 events costs
 * model calls only for the few that matter. Counts per rule per day go to `trigger_stats`.
 */
export interface CompanyEvent {
  /** Unique per event (the feed's own id + timepoint); a repeat in the same batch is ignored. */
  id: string;
  entity_id: string;
  kind: TriggerRule["kind"];
  /** Event fields used by `match` (e.g. company_status, category) plus `changed`: changed field names. */
  data: Record<string, unknown>;
  published_at: string;
}

export interface TriggerActions {
  reverify(entityId: string, reason: string): Promise<void>;
  alert(message: string, details: Record<string, unknown>): Promise<void>;
  /** The only action that calls the model. */
  explain(entityId: string, reason: string): Promise<void>;
}

export interface TriggerScope {
  universe: Set<string>;
  opportunity: Set<string>;
  watched: Set<string>;
}

export async function loadTriggerScope(
  storage: Storage,
  universeName: string,
): Promise<TriggerScope> {
  const universe = new Set(
    (await storage.universe.list(universeName, { included: true })).map((m) => m.entity_id),
  );
  const opportunity = new Set<string>();
  for (const status of ["proposed", "approved", "actioned"] as const)
    for (const o of await storage.opportunities.list({ status, limit: 100_000 }))
      opportunity.add(o.entity_id);
  const watched = new Set((await storage.watches.active()).map((w) => w.entity_id));
  return { universe, opportunity, watched };
}

const inScope = (rule: TriggerRule, id: string, s: TriggerScope) =>
  rule.scope === "universe"
    ? s.universe.has(id)
    : rule.scope === "opportunity"
      ? s.opportunity.has(id)
      : s.watched.has(id) || s.opportunity.has(id);

/** Pure: does this rule match this event? (No I/O, no model.) */
export function ruleMatches(rule: TriggerRule, e: CompanyEvent, scope: TriggerScope): boolean {
  if (rule.kind !== e.kind) return false;
  if (!inScope(rule, e.entity_id, scope)) return false;
  for (const [key, allowed] of Object.entries(rule.match)) {
    const v = e.data[key];
    const values = Array.isArray(v)
      ? v.map(String)
      : v === undefined || v === null
        ? []
        : [String(v)];
    if (!values.some((x) => allowed.includes(x))) return false;
  }
  return true;
}

export interface TriggerRunStats {
  events: number;
  matched: number;
  model_calls: number;
  by_rule: Record<string, { seen: number; matched: number; acted: number; model_calls: number }>;
}

export async function processEvents(
  storage: Storage,
  cfg: TriggersConfig,
  events: CompanyEvent[],
  scope: TriggerScope,
  actions: TriggerActions,
  now: Date = new Date(),
): Promise<TriggerRunStats> {
  const seenIds = new Set<string>();
  const stats: TriggerRunStats = { events: 0, matched: 0, model_calls: 0, by_rule: {} };
  for (const r of cfg.rules)
    stats.by_rule[r.id] = { seen: 0, matched: 0, acted: 0, model_calls: 0 };
  // Every event given is processed (never silently dropped); batch size is applied where events are
  // put on the queue (chunkEvents).
  for (const e of events) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    stats.events++;
    // Every matching rule acts (config order); reverifying twice is harmless, the model runs only for
    // `explain` rules.
    let any = false;
    for (const rule of cfg.rules) {
      const s = stats.by_rule[rule.id] as TriggerRunStats["by_rule"][string];
      if (rule.kind === e.kind) s.seen++;
      if (!ruleMatches(rule, e, scope)) continue;
      s.matched++;
      any = true;
      const why = `${rule.id} (${e.kind} event ${e.id})`;
      if (rule.action === "reverify") await actions.reverify(e.entity_id, why);
      else if (rule.action === "reverify_and_alert") {
        await actions.reverify(e.entity_id, why);
        await actions.alert(`${e.entity_id}: ${rule.id}`, { event: e.id, data: e.data });
      } else {
        await actions.explain(e.entity_id, why);
        s.model_calls++;
        stats.model_calls++;
      }
      s.acted++;
    }
    if (any) stats.matched++;
  }
  const day = now.toISOString().slice(0, 10);
  for (const [rule, s] of Object.entries(stats.by_rule))
    if (s.seen) await storage.triggerStats.bump(day, rule, s);
  return stats;
}

/** Splits events into queue-message-sized batches (config `max_events_per_batch`). */
export function chunkEvents(events: CompanyEvent[], cfg: TriggersConfig): CompanyEvent[][] {
  const out: CompanyEvent[][] = [];
  for (let i = 0; i < events.length; i += cfg.max_events_per_batch)
    out.push(events.slice(i, i + cfg.max_events_per_batch));
  return out;
}
