import type { InfraConfig } from "@ae/config";
import { createTask, type LoadedPlaybook } from "@ae/infra";
import type { QueueBus } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { canonicalJson } from "@ae/verification";

/**
 * Watch lists (Phase 5). A change = a NEW VERSION of a watched fact whose value differs from the
 * previous version (confidence-only refreshes don't count). Each change becomes a `watch_alert` task,
 * idempotent per watch + fact version, so an alert is never sent twice.
 */
export async function detectChanges(storage: Storage, since: string) {
  const watches = await storage.watches.active();
  if (!watches.length) return [];
  const fields = [...new Set(watches.flatMap((w) => w.fields))];
  const versions = await storage.facts.listVersionsFor(
    [...new Set(watches.map((w) => w.entity_id))],
    fields,
  );
  const changes = [];
  for (const w of watches) {
    for (const field of w.fields) {
      const vs = versions
        .filter((v) => v.fact.entity_id === w.entity_id && v.fact.field === field)
        .sort((a, b) => a.version - b.version);
      for (let i = 1; i < vs.length; i++) {
        const cur = vs[i] as (typeof vs)[number];
        const prev = vs[i - 1] as (typeof vs)[number];
        if (cur.recorded_at <= since) continue;
        if (canonicalJson(cur.fact.value) === canonicalJson(prev.fact.value)) continue;
        changes.push({
          watch: w,
          field,
          old_value: prev.fact.value,
          new_value: cur.fact.value,
          version: cur.version,
          confidence: cur.fact.confidence,
          recorded_at: cur.recorded_at,
        });
      }
    }
  }
  return changes;
}

export async function queueAlerts(
  storage: Storage,
  infra: InfraConfig,
  playbooks: Map<string, LoadedPlaybook>,
  queue: QueueBus,
  since: string,
) {
  const changes = await detectChanges(storage, since);
  let created = 0;
  for (const c of changes) {
    const r = await createTask(storage, infra, playbooks, queue, {
      idempotency_key: `alert:${c.watch.id}:${c.watch.entity_id}:${c.field}:${c.version}`,
      playbook: "watch_alert",
      revenue_path: "monitoring",
      source_ref: `watch:${c.watch.id}:entity:${c.watch.entity_id}`,
      lane: "open",
      state: { change: { ...c, watch_id: c.watch.id } },
    });
    if (r.created) created++;
  }
  return { changes: changes.length, tasks_created: created };
}
