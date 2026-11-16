import type { TriggersConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts, type VerificationContext } from "@ae/verification";
import type { CompanyEvent } from "./triggers.ts";

/**
 * The Companies House change feed (v2 decision D3): a Durable Object holds the feed's position
 * (timepoint) with strongly consistent storage and reads it on an alarm; events go to the jobs queue
 * and through the trigger rules. Polling is the fallback whenever the feed is not configured or has
 * gone quiet for `feed_stale_minutes`.
 *
 * The SOURCE is a port. The Companies House streaming adapter is not built yet: its documentation host
 * was blocked from the build environment, and the rule is to check current docs before using an API.
 * Until it exists the feed reports "not configured" and polling does the work.
 */
export interface FeedRead {
  events: CompanyEvent[];
  /** Position to resume from next time (null = unchanged). */
  timepoint: string | null;
}

export interface ChangeFeedSource {
  readonly name: string;
  read(timepoint: string | null, budgetMs: number): Promise<FeedRead>;
}

export interface FeedState {
  timepoint: string | null;
  last_event_at: string | null;
  last_read_at: string | null;
}

/** One alarm's worth of reading: events out to `deliver` (the queue), position kept only after delivery. */
export async function runFeedOnce(
  source: ChangeFeedSource,
  state: FeedState,
  deliver: (events: CompanyEvent[]) => Promise<void>,
  o: { budgetMs: number; now?: Date },
): Promise<FeedState> {
  const now = (o.now ?? new Date()).toISOString();
  const r = await source.read(state.timepoint, o.budgetMs);
  // Deliver first, then move the position: a crash in between re-reads (at-least-once); the trigger
  // filter ignores repeats in a batch and every action is safe to repeat.
  if (r.events.length) await deliver(r.events);
  return {
    timepoint: r.timepoint ?? state.timepoint,
    last_event_at: r.events.length ? now : state.last_event_at,
    last_read_at: now,
  };
}

/** True when polling should take over: no feed, or no event or read within the stale window. */
export function feedIsStale(
  status: { at: string; detail: unknown } | undefined,
  cfg: TriggersConfig,
  now: Date = new Date(),
): boolean {
  const d = status?.detail as
    | { configured?: boolean; last_event_at?: string | null }
    | null
    | undefined;
  if (!status || !d?.configured) return true;
  const last = d.last_event_at ?? status.at;
  return now.getTime() - Date.parse(last) > cfg.fallback_poll.feed_stale_minutes * 60_000;
}

const WATCHED_FIELDS = ["company_status", "registered_office_address"] as const;

/**
 * Polling fallback: refreshes the next few companies that matter most (live leads and watched companies,
 * in rotation) from the Companies House API and turns any change in status or registered office into
 * the same CompanyEvent the feed would have sent, so the trigger rules don't care where it came from.
 */
export async function pollFallback(
  storage: Storage,
  ctx: VerificationContext,
  cfg: TriggersConfig,
  refresh: (entityId: string) => Promise<boolean>,
  now: Date = new Date(),
): Promise<{ polled: number; events: CompanyEvent[] }> {
  const ids = new Set<string>();
  for (const w of await storage.watches.active()) ids.add(w.entity_id);
  for (const status of ["approved", "proposed", "actioned"] as const)
    for (const o of await storage.opportunities.list({ status, limit: 10_000 }))
      ids.add(o.entity_id);
  const all = [...ids].sort();
  if (!all.length) return { polled: 0, events: [] };
  const cursor = ((await storage.runtimeStatus.all()).find((s) => s.name === "poll_cursor")
    ?.detail ?? 0) as number;
  const n = cfg.fallback_poll.entities_per_poll;
  const pick = Array.from(
    { length: Math.min(n, all.length) },
    (_, i) => all[(cursor + i) % all.length] as string,
  );
  await storage.runtimeStatus.beat("poll_cursor", (cursor + pick.length) % all.length);
  const snapshot = async () =>
    getVerifiedFacts(storage, ctx, {
      entities: pick,
      fields: [...WATCHED_FIELDS],
      minConfidence: 0,
      asOf: new Date().toISOString(),
      lanes: ["open"],
      caller: "internal",
    });
  const before = await snapshot();
  let polled = 0;
  for (const id of pick) if (await refresh(id)) polled++;
  const after = await snapshot();
  const value = (facts: typeof before, id: string, f: string) =>
    JSON.stringify(facts.find((x) => x.entity_id === id && x.field === f)?.value ?? null);
  const events: CompanyEvent[] = [];
  for (const id of pick) {
    const changed = WATCHED_FIELDS.filter((f) => value(before, id, f) !== value(after, id, f));
    if (!changed.length) continue;
    const status = after.find((x) => x.entity_id === id && x.field === "company_status")?.value;
    events.push({
      id: `poll:${id}:${now.toISOString()}`,
      entity_id: id,
      kind: "company",
      data: { changed, company_status: status ?? null },
      published_at: now.toISOString(),
    });
  }
  return { polled, events };
}
