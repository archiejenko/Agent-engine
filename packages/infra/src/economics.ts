import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";

/**
 * Unit economics (v2 Phase 1): per task, playbook and experiment — model and API cost, send cost,
 * revenue, margin and Archie's minutes. Revenue is the task's attributed revenue (payments are added to
 * the task that earned them). Human minutes come from review sessions; a session that covered several
 * tasks (a print batch) is split evenly between them.
 */
export interface EconomicsRow {
  key: string;
  tasks: number;
  model_cost_gbp: number;
  send_cost_gbp: number;
  revenue_gbp: number;
  margin_gbp: number;
  human_minutes: number;
}

const blank = (key: string): EconomicsRow => ({
  key,
  tasks: 0,
  model_cost_gbp: 0,
  send_cost_gbp: 0,
  revenue_gbp: 0,
  margin_gbp: 0,
  human_minutes: 0,
});

export async function unitEconomics(
  storage: Storage,
  cfg: InfraConfig,
  /** `until` (exclusive) closes the window, so two adjacent periods never share a task or minute. */
  o: { since: string; until?: string; includeSynthetic: boolean; taskLimit?: number },
) {
  const tasks = (await storage.tasks.list({ since: o.since, limit: 100_000 })).filter(
    (t) => (o.includeSynthetic || !t.synthetic) && (!o.until || t.created_at < o.until),
  );
  const cost = await storage.runLog.costByTask(o.since);
  const minutes = new Map<string, number>();
  for (const s of await storage.reviewSessions.since({
    since: o.since,
    includeSynthetic: o.includeSynthetic,
  })) {
    if (o.until && s.decided_at >= o.until) continue;
    const share = s.active_ms / 60_000 / Math.max(1, s.task_ids.length);
    for (const id of s.task_ids) minutes.set(id, (minutes.get(id) ?? 0) + share);
  }
  const perTask: (EconomicsRow & { playbook: string; experiment_id: string | null })[] = [];
  const byPlaybook = new Map<string, EconomicsRow>();
  const byExperiment = new Map<string, EconomicsRow>();
  for (const t of tasks) {
    const c = cost.get(t.task_id) ?? { send_gbp: 0, other_gbp: 0 };
    const emailSends = (
      await storage.outbox.forEntity(t.source_ref.split(":").pop() as string)
    ).filter((m) => m.task_id === t.task_id && m.status === "sent").length;
    const send = c.send_gbp + emailSends * cfg.measurement.email_send_cost_gbp;
    const row: EconomicsRow = {
      key: t.task_id,
      tasks: 1,
      model_cost_gbp: c.other_gbp,
      send_cost_gbp: send,
      revenue_gbp: t.revenue_gbp,
      margin_gbp: t.revenue_gbp - c.other_gbp - send,
      human_minutes: minutes.get(t.task_id) ?? 0,
    };
    const experiment = (t.state as { experiment_id?: string }).experiment_id ?? null;
    perTask.push({ ...row, playbook: t.playbook, experiment_id: experiment });
    for (const [map, key] of [
      [byPlaybook, t.playbook],
      [byExperiment, experiment],
    ] as const) {
      if (!key) continue;
      const agg = map.get(key) ?? blank(key);
      agg.tasks++;
      agg.model_cost_gbp += row.model_cost_gbp;
      agg.send_cost_gbp += row.send_cost_gbp;
      agg.revenue_gbp += row.revenue_gbp;
      agg.margin_gbp += row.margin_gbp;
      agg.human_minutes += row.human_minutes;
      map.set(key, agg);
    }
  }
  const round = (r: EconomicsRow): EconomicsRow => ({
    ...r,
    model_cost_gbp: Number(r.model_cost_gbp.toFixed(4)),
    send_cost_gbp: Number(r.send_cost_gbp.toFixed(4)),
    revenue_gbp: Number(r.revenue_gbp.toFixed(2)),
    margin_gbp: Number(r.margin_gbp.toFixed(4)),
    human_minutes: Number(r.human_minutes.toFixed(1)),
  });
  return {
    since: o.since,
    label: o.includeSynthetic ? "SIMULATED (synthetic rows included)" : "real",
    by_playbook: [...byPlaybook.values()].map(round).sort((a, b) => a.key.localeCompare(b.key)),
    by_experiment: [...byExperiment.values()].map(round),
    by_task: perTask
      .slice(0, o.taskLimit ?? 50)
      .map((r) => ({ ...round(r), playbook: r.playbook, experiment_id: r.experiment_id })),
  };
}
