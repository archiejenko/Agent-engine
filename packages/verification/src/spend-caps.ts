import type { InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";

/**
 * The daily spend caps (guardrail 6), shared by the agent runtime (`checkSpend` in @ae/infra) and the
 * website extractor: one check, reading cost_events (via daily_rollups). Live, non-dry-run spend only,
 * so sandbox, probe and planner spend never count. It lives beside the model meter so verification can
 * use it without depending on infra.
 */
export const dayStart = (now: Date) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

export function playbookCap(caps: InfraConfig["caps"], playbook: string): number {
  return caps.per_playbook_per_day_gbp[playbook] ?? caps.per_playbook_per_day_gbp.default ?? 0;
}

/**
 * Which daily caps today's spend is over (empty = none). `extraGbp` is a cost not yet written to
 * cost_events. `realOnly` leaves out synthetic (fake-model) spend: for a cap on real money where
 * simulated runs must not trip it (the website extractor). Agent caps keep counting synthetic spend so
 * the budget gates bite in simulated worlds.
 */
export async function dailyCapProblems(
  storage: Storage,
  caps: InfraConfig["caps"],
  playbook: string,
  o: { now?: Date; extraGbp?: number; realOnly?: boolean } = {},
): Promise<string[]> {
  const day = dayStart(o.now ?? new Date());
  const extra = o.extraGbp ?? 0;
  const ex = caps.exclude_steps;
  const real = o.realOnly === true;
  const problems: string[] = [];
  const cap = playbookCap(caps, playbook);
  if (
    (await storage.costEvents.spendSince(day, { playbook, excludeSteps: ex, realOnly: real })) +
      extra >
    cap + 1e-9
  )
    problems.push(`${playbook} daily cap £${cap}`);
  if (
    (await storage.costEvents.spendSince(day, { excludeSteps: ex, realOnly: real })) + extra >
    caps.global_per_day_gbp + 1e-9
  )
    problems.push(`global daily cap £${caps.global_per_day_gbp}`);
  return problems;
}
