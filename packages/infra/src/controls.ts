import type { InfraConfig } from "@ae/config";
import type { Autonomy } from "@ae/contracts";
import type { Storage } from "@ae/storage";
import { dailyCapProblems } from "@ae/verification";

/**
 * Kill switches, spend caps, queue pause and autonomy, stored in the controls table.
 * Kill switch ON = no external action may happen: external tools run in dry-run (recorded, not done).
 * The global switch defaults to ON until Archie turns it off (config: kill_switch_default_on).
 */
export const K = {
  global: "kill:global",
  playbook: (p: string) => `kill:playbook:${p}`,
  queuePaused: "queue:paused",
  autonomy: (p: string) => `autonomy:${p}`,
  spendTier: (p: string) => `spend_tier:${p}`,
};

export async function externalActionsAllowed(
  storage: Storage,
  cfg: InfraConfig,
  playbook: string,
): Promise<boolean> {
  const global = (await storage.controls.get<boolean>(K.global)) ?? cfg.kill_switch_default_on;
  const pb = (await storage.controls.get<boolean>(K.playbook(playbook))) ?? false;
  return !global && !pb;
}

export async function setKillSwitch(
  storage: Storage,
  scope: "global" | { playbook: string },
  on: boolean,
  by: string,
) {
  const key = scope === "global" ? K.global : K.playbook(scope.playbook);
  await storage.controls.set(key, on, by);
  await storage.alerts.raise(
    "kill_switch",
    scope === "global"
      ? `Sending ${on ? "stopped for everything (dry run)" : "turned LIVE"} by ${by}`
      : `${scope.playbook}: own switch ${on ? "stopped" : "turned on"} by ${by}`,
    { by },
  );
}

export async function queuePaused(storage: Storage): Promise<boolean> {
  return (await storage.controls.get<boolean>(K.queuePaused)) ?? false;
}

export async function playbookAutonomy(
  storage: Storage,
  playbook: string,
  fallback: Autonomy,
): Promise<Autonomy> {
  return (await storage.controls.get<Autonomy>(K.autonomy(playbook))) ?? fallback;
}

export class SpendCapError extends Error {}

/**
 * Spend caps (guardrail 6): per task (its budget), per playbook per day, global per day.
 * Hitting a cap pauses the queue and raises an alert.
 */
export async function checkSpend(
  storage: Storage,
  cfg: InfraConfig,
  task: { task_id: string; playbook: string; budget_gbp: number; cost_gbp: number },
  extraGbp: number,
  now = new Date(),
  o: { recorded?: boolean } = {},
): Promise<void> {
  // `recorded`: the cost is already in cost_events (written at call time), so the daily sums include
  // it and only the task budget still needs `extraGbp` added.
  const problems: string[] = [];
  if (task.cost_gbp + extraGbp > task.budget_gbp + 1e-9)
    problems.push(`task budget £${task.budget_gbp.toFixed(2)}`);
  problems.push(
    ...(await dailyCapProblems(storage, cfg.caps, task.playbook, {
      now,
      extraGbp: o.recorded ? 0 : extraGbp,
    })),
  );
  if (problems.length) {
    if (!problems[0]?.startsWith("task budget"))
      await storage.controls.set(K.queuePaused, true, "spend_cap");
    await storage.alerts.raise("spend_cap", `Spend cap hit: ${problems.join(", ")}`, {
      task_id: task.task_id,
      playbook: task.playbook,
    });
    throw new SpendCapError(problems.join(", "));
  }
}
