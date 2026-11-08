import type { InfraConfig } from "@ae/config";
import type { Autonomy } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { K, playbookAutonomy } from "./controls.ts";

/**
 * Autonomy promotion (Phase 5). Per playbook, over its last 50 tasks: success rate (target ≥ 90%),
 * approved-without-edit rate (≥ 80%), guardrail breaches (0). Promotion is Archie's click and only
 * allowed when the targets are met; ANY breach auto-demotes one level immediately.
 */
const LEVELS: Autonomy[] = ["L0", "L1", "L2", "L3"];

export async function playbookStats(storage: Storage, playbook: string, cfg: InfraConfig) {
  const tasks = await storage.tasks.list({ playbook, limit: cfg.autonomy.window });
  const finished = tasks.filter((t) => ["done", "failed", "cancelled"].includes(t.status));
  const done = finished.filter((t) => t.status === "done").length;
  let approvals = 0;
  let noEdit = 0;
  for (const t of tasks) {
    for (const a of await storage.approvals.forTask(t.task_id)) {
      if (a.decision === "reject") continue;
      approvals++;
      if (a.decision === "approve") noEdit++;
    }
  }
  const breaches = (await storage.alerts.list({ limit: 10_000 })).filter(
    (a) =>
      a.kind === "guardrail_breach" &&
      (a.details as { playbook?: string }).playbook === playbook &&
      tasks.some((t) => t.task_id === (a.details as { task_id?: string }).task_id),
  ).length;
  return {
    playbook,
    tasks: tasks.length,
    success_rate: finished.length ? done / finished.length : 0,
    approved_without_edit: approvals ? noEdit / approvals : 0,
    breaches,
    cost_gbp: tasks.reduce((a, t) => a + t.cost_gbp, 0),
    revenue_gbp: tasks.reduce((a, t) => a + t.revenue_gbp, 0),
  };
}

export async function promotePlaybook(
  storage: Storage,
  playbook: string,
  base: Autonomy,
  cfg: InfraConfig,
  by: string,
) {
  const s = await playbookStats(storage, playbook, cfg);
  const a = cfg.autonomy;
  const problems = [
    ...(s.tasks < a.min_tasks ? [`only ${s.tasks} tasks (need ${a.min_tasks})`] : []),
    ...(s.success_rate < a.min_success
      ? [`success ${(s.success_rate * 100).toFixed(0)}% < ${a.min_success * 100}%`]
      : []),
    ...(s.approved_without_edit < a.min_no_edit
      ? [
          `approved without edits ${(s.approved_without_edit * 100).toFixed(0)}% < ${a.min_no_edit * 100}%`,
        ]
      : []),
    ...(s.breaches > a.max_breaches ? [`${s.breaches} guardrail breaches`] : []),
  ];
  if (problems.length) throw new Error(`can't promote ${playbook}: ${problems.join("; ")}`);
  const current = await playbookAutonomy(storage, playbook, base);
  const next = LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(current) + 1)] as Autonomy;
  await storage.controls.set(K.autonomy(playbook), next, by);
  await storage.alerts.raise("autonomy", `${playbook} promoted ${current} → ${next} by ${by}`, s);
  return next;
}

/** Any guardrail breach: record it and drop the playbook one level, immediately. */
export async function recordBreach(
  storage: Storage,
  d: { playbook: string; task_id: string; tool: string; reason: string; base: Autonomy },
) {
  await storage.alerts.raise(
    "guardrail_breach",
    `${d.playbook}: ${d.tool} blocked — ${d.reason}`,
    d,
  );
  const current = await playbookAutonomy(storage, d.playbook, d.base);
  const down = LEVELS[Math.max(0, LEVELS.indexOf(current) - 1)] as Autonomy;
  if (down !== current) {
    await storage.controls.set(K.autonomy(d.playbook), down, "auto-demote");
    await storage.alerts.raise(
      "autonomy",
      `${d.playbook} auto-demoted ${current} → ${down} after a guardrail breach`,
      d,
    );
  }
}
