import type { Arm } from "@ae/contracts";
import type { Storage } from "@ae/storage";

/**
 * Lift against the holdout (v2 Phase 1). Measured on ASSIGNMENT (intent to treat, decision D4): every
 * company assigned to an arm counts in that arm's denominator, whether or not its draft was approved.
 * Drafts Archie rejected are reported separately as attrition. Intermediate signals (scans, visits,
 * replies) give an early read; a result counts as "supported by paid outcomes" only when the paid lift's
 * interval excludes 1.
 *
 * This is a REPORT. With `includeSynthetic` it can show simulator rows, labelled SIMULATED; it never
 * feeds learning.
 */
export interface ArmStats {
  assigned: number;
  rejected_drafts: number;
}
export interface EventLift {
  event: string;
  ranked: { companies: number; rate: number };
  holdout: { companies: number; rate: number };
  /** ranked rate ÷ holdout rate. */
  lift: number | null;
  ci95: [number, number] | null;
  /** True when the interval is entirely above 1. */
  better_than_holdout: boolean;
}
export interface LiftReport {
  label: "real" | "SIMULATED (synthetic rows included)";
  cohorts: number;
  arms: Record<Arm, ArmStats>;
  events: EventLift[];
  supported_by_paid: boolean;
  note: string;
}

const READ_EVENTS = ["sent", "qr_scan", "demo_visit", "reply", "reply_positive", "booking", "paid"];

/** Rate ratio with a 95% interval on the log scale (Katz), adding 0.5 to every cell when a count is 0. */
export function rateRatio(
  a: number,
  n1: number,
  b: number,
  n2: number,
): { ratio: number; ci95: [number, number] } | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const fix = a === 0 || b === 0 ? 0.5 : 0;
  const A = a + fix;
  const B = b + fix;
  const N1 = n1 + 2 * fix;
  const N2 = n2 + 2 * fix;
  const ratio = A / N1 / (B / N2);
  const se = Math.sqrt(1 / A - 1 / N1 + 1 / B - 1 / N2);
  return { ratio, ci95: [ratio * Math.exp(-1.96 * se), ratio * Math.exp(1.96 * se)] };
}

export async function liftReport(
  storage: Storage,
  o: { includeSynthetic: boolean; cohortIds?: string[] } = { includeSynthetic: false },
): Promise<LiftReport> {
  const cohorts = (
    await storage.cohorts.list({ includeSynthetic: o.includeSynthetic, limit: 10_000 })
  ).filter((c) => !o.cohortIds || o.cohortIds.includes(c.id));
  const arms: Record<Arm, ArmStats> = {
    ranked: { assigned: 0, rejected_drafts: 0 },
    holdout: { assigned: 0, rejected_drafts: 0 },
  };
  for (const c of cohorts)
    for (const m of await storage.cohorts.members(c.id)) {
      if (m.status !== "assigned") continue;
      arms[m.arm].assigned++;
      const t = m.task_id ? await storage.tasks.get(m.task_id) : null;
      if (t?.status === "cancelled") arms[m.arm].rejected_drafts++;
    }
  const funnel = await storage.outcomeLedger.cohortFunnel({
    includeSynthetic: o.includeSynthetic,
    cohortIds: cohorts.map((c) => c.id),
  });
  const count = (arm: Arm, event: string) =>
    funnel.find((f) => f.arm === arm && f.event === event)?.companies ?? 0;
  const events: EventLift[] = READ_EVENTS.map((event) => {
    const a = count("ranked", event);
    const b = count("holdout", event);
    const rr = rateRatio(a, arms.ranked.assigned, b, arms.holdout.assigned);
    return {
      event,
      ranked: { companies: a, rate: arms.ranked.assigned ? a / arms.ranked.assigned : 0 },
      holdout: { companies: b, rate: arms.holdout.assigned ? b / arms.holdout.assigned : 0 },
      lift: rr?.ratio ?? null,
      ci95: rr?.ci95 ?? null,
      better_than_holdout: rr ? rr.ci95[0] > 1 : false,
    };
  });
  const paid = events.find((e) => e.event === "paid");
  const supported = Boolean(paid?.better_than_holdout);
  return {
    label: o.includeSynthetic ? "SIMULATED (synthetic rows included)" : "real",
    cohorts: cohorts.length,
    arms,
    events,
    supported_by_paid: supported,
    note: supported
      ? "Paid outcomes support the lift."
      : "Unproven: no paid-outcome lift yet. Earlier signals may guide proposals but can't justify a budget increase or weight change on their own.",
  };
}
