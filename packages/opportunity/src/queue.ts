import type { Storage, StoredOpportunity } from "@ae/storage";

/** One company from several modules appears once in Archie's queue, with all its reasons. */
export interface QueueItem {
  entity_id: string;
  best_score: number;
  best_expected_value_gbp: number;
  explore: boolean;
  opportunities: StoredOpportunity[];
}

export async function reviewQueue(storage: Storage, limit = 50): Promise<QueueItem[]> {
  const proposed = await storage.opportunities.list({ status: "proposed", limit: 5000 });
  const by = new Map<string, StoredOpportunity[]>();
  for (const o of proposed) by.set(o.entity_id, [...(by.get(o.entity_id) ?? []), o]);
  return [...by.entries()]
    .map(([entity_id, opps]) => ({
      entity_id,
      best_score: Math.max(...opps.map((o) => o.score)),
      best_expected_value_gbp: Math.max(...opps.map((o) => o.expected_value_gbp)),
      explore: opps.every((o) => o.explore),
      opportunities: opps,
    }))
    .sort(
      (a, b) =>
        b.best_expected_value_gbp - a.best_expected_value_gbp ||
        a.entity_id.localeCompare(b.entity_id),
    )
    .slice(0, limit);
}
