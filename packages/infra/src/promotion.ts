import type { GraphPolicy } from "@ae/config";
import type { CompiledGraph, GraphSpec } from "@ae/contracts";
import type { DecisionOption, Storage } from "@ae/storage";
import { K } from "./controls.ts";

/**
 * Task graph G5: trust is earned per graph shape, never granted per run.
 *
 * - A finished run is **settled** `settle_after_days` after it ends: its success metric is read from the
 *   outcome ledger, the shape's record is updated, and the outcome is written back (to the run, and to the
 *   opportunity engine's outcomes when the graph came from an opportunity).
 * - **Only real runs count** (rules 10–12): synthetic or dry-run runs never count towards a shape's record
 *   and never write an opportunity outcome. The gate's synthetic history uses the test-only `testMode`
 *   switch; a static test keeps it out of production code.
 * - A shape with ≥ `min_live_runs` runs, ≤ `max_breaches` breaches and a Wilson lower bound on its success
 *   rate ≥ `min_success_lower_bound` is **suggested for promotion**. Approving writes a promoted playbook
 *   version (stored in D1) at **L1**; from there it earns levels like any playbook.
 * - **A breach drops the shape (and its promoted playbook) one level.**
 */
const LEVELS = ["L0", "L1", "L2", "L3"] as const;
type Level = (typeof LEVELS)[number];

/** Lower bound of the Wilson score interval for k successes in n trials. */
export function wilsonLower(k: number, n: number, z: number): number {
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** What a run's success metric reads in the ledger (only the run's own task; synthetic only in test mode). */
export async function measureRun(
  storage: Storage,
  spec: GraphSpec,
  taskId: string,
  o: { includeSynthetic: boolean },
): Promise<number> {
  const rows = (await storage.outcomeLedger.list({ limit: 10_000, taskId })).filter(
    (r) => o.includeSynthetic || (!r.synthetic && !r.dry_run),
  );
  switch (spec.successMetric.measuredBy) {
    case "count_replies":
      return rows.filter((r) => r.event === "reply").length;
    case "count_paid":
      return rows.filter((r) => r.event === "paid").length;
    case "draft_approved":
      return (await storage.approvals.forTask(taskId)).filter((a) => a.decision !== "reject")
        .length;
    default:
      return 0;
  }
}

export interface SettleResult {
  run_id: string;
  fingerprint: string;
  met: boolean;
  counted: boolean;
  reason: string;
}

/**
 * Settles finished runs that ended at least `settle_after_days` ago and aren't settled yet. Idempotent:
 * a settled run carries its outcome in `outcome_id`.
 */
export async function settleGraphRuns(
  storage: Storage,
  policy: GraphPolicy,
  o: { now?: Date; testMode?: boolean } = {},
): Promise<SettleResult[]> {
  const now = o.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - policy.promotion.settle_after_days * 86_400_000,
  ).toISOString();
  const out: SettleResult[] = [];
  for (const run of await storage.graphRuns.list({ limit: 1000 })) {
    if (run.outcome_id || !run.ended_at || run.ended_at > cutoff) continue;
    if (run.mode !== "live") continue; // sandbox and probe runs never build a shape's record
    if (!["done", "failed"].includes(run.status)) continue;
    const row = await storage.graphSpecs.get(run.graph_id, run.version);
    const compiled = row?.compiled as CompiledGraph | null;
    if (!row || !compiled) continue;
    const spec = compiled.spec;
    const fp = compiled.shapeFingerprint;
    const taskId = (await storage.tasks.list({ limit: 5000 })).find(
      (t) => (t.state as { graph_run?: { run_id: string } }).graph_run?.run_id === run.run_id,
    )?.task_id;
    if (!taskId) continue;
    const dry = (await storage.effects.forTask(taskId)).some((e) => e.dry_run);
    const counted = o.testMode === true || (!run.synthetic && !dry);
    const value = await measureRun(storage, spec, taskId, {
      includeSynthetic: o.testMode === true,
    });
    const met = run.status === "done" && value >= spec.successMetric.target;
    if (counted) {
      await storage.graphShapes.ensure(fp);
      await storage.graphShapes.record(fp, {
        met_metric: met,
        breach: false,
        cost_gbp: run.cost_so_far_gbp,
      });
      // Write-back for the opportunity engine: real, settled outcomes only.
      const opp = spec.opportunityId;
      if (opp && /^[0-9a-f-]{36}$/.test(opp))
        await storage.outcomes.add({
          opportunity_id: opp,
          entity_id: (await storage.opportunities.get(opp))?.entity_id ?? "unknown",
          module: null,
          event: met ? "graph_route_met" : "graph_route_missed",
          value_bool: met,
          value_gbp: null,
          observed_at: now.toISOString(),
          source: "system",
        });
    }
    await storage.graphRuns.update(run.run_id, {
      outcome_id: `${met ? "met" : "missed"}:${fp.slice(0, 16)}`,
    });
    out.push({
      run_id: run.run_id,
      fingerprint: fp,
      met,
      counted,
      reason: counted
        ? `${spec.successMetric.measuredBy} = ${value} (target ${spec.successMetric.target})`
        : run.synthetic
          ? "synthetic: never counts"
          : "dry-run: never counts",
    });
  }
  return out;
}

const PROMOTION_OPTIONS: DecisionOption[] = [
  {
    key: "promote",
    label: "Promote",
    effect: "Write it as a playbook version at L1; it earns levels from there",
  },
  { key: "not_now", label: "Not now", effect: "Keep running it as a bespoke graph (L1 at most)" },
];

/** Shapes that have earned a promotion suggestion; opens one decision each (idempotent). */
export async function suggestPromotions(storage: Storage, policy: GraphPolicy, now = new Date()) {
  const p = policy.promotion;
  const suggested: string[] = [];
  for (const s of await storage.graphShapes.list()) {
    if (s.promoted_playbook) continue;
    const lb = wilsonLower(s.met_metric, s.live_runs, p.wilson_z);
    if (
      s.live_runs < p.min_live_runs ||
      s.breaches > p.max_breaches ||
      lb < p.min_success_lower_bound
    )
      continue;
    const ref = `shape:${s.fingerprint}`;
    if (!(await storage.decisions.openFor("promotion", ref)))
      await storage.decisions.open({
        type: "promotion",
        source_ref: ref,
        summary: `Promote a graph shape: ${s.met_metric}/${s.live_runs} runs met their metric, ${s.breaches} breaches (success at least ${Math.round(lb * 100)}%)`,
        money_at_stake_gbp: 0,
        money_kind: "none",
        options: PROMOTION_OPTIONS,
        recommended: "promote",
        safe_default: "not_now",
        deadline: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        context: {
          fingerprint: s.fingerprint,
          runs: s.live_runs,
          met: s.met_metric,
          lower_bound: lb,
        },
        synthetic: false,
      });
    suggested.push(s.fingerprint);
  }
  return suggested;
}

/** Archie promotes a shape: a new promoted playbook version, at L1. */
export async function applyPromotionOption(
  storage: Storage,
  ref: string,
  option: string,
  approvalId: string | null,
) {
  if (option !== "promote" || !approvalId) return;
  const fp = ref.slice("shape:".length);
  const specs = (await storage.graphSpecs.list({ limit: 1000 })).filter(
    (g) => g.shape_fingerprint === fp && g.compiled,
  );
  const src = specs.at(-1);
  if (!src) throw new Error("no compiled graph has this shape");
  const compiled = src.compiled as CompiledGraph;
  const base =
    (
      compiled.spec.nodes.find((n) => n.kind === "role")?.config as
        | { playbook?: string }
        | undefined
    )?.playbook ?? "graph";
  const name = `promoted_${base}_${fp.slice(0, 8)}`;
  const version =
    (await storage.promotedPlaybooks.list()).filter((p) => p.name === name).length + 1;
  const skill = [
    "---",
    `name: ${name}`,
    `version: ${version}`,
    "autonomy: L1",
    `shape: ${fp}`,
    `promoted_from: ${src.graph_id}@${src.version}`,
    "---",
    "",
    `# ${name}`,
    "",
    `Promoted from graph shape ${fp.slice(0, 12)} after Archie's approval. It starts at L1 and earns levels`,
    "under the last-50-tasks rule like every playbook. A breach drops it one level.",
    "",
    `Goal: ${compiled.spec.goal}`,
  ].join("\n");
  await storage.promotedPlaybooks.add({
    name,
    version,
    fingerprint: fp,
    spec: compiled.spec,
    skill_md: skill,
    autonomy: "L1",
    approval_id: approvalId,
  });
  await storage.graphShapes.setPromoted(fp, name, version);
  await storage.graphShapes.setAutonomy(fp, "L1");
  await storage.controls.set(K.autonomy(name), "L1", "promotion");
}

/** A breach in a run: the shape (and its promoted playbook, if any) drops one level. */
export async function recordShapeBreach(storage: Storage, fp: string, reason: string) {
  await storage.graphShapes.ensure(fp);
  await storage.graphShapes.record(fp, { met_metric: false, breach: true, cost_gbp: 0 });
  const s = await storage.graphShapes.get(fp);
  const current = (s?.autonomy ?? "L1") as Level;
  const down = LEVELS[Math.max(0, LEVELS.indexOf(current) - 1)] as Level;
  await storage.graphShapes.setAutonomy(fp, down);
  if (s?.promoted_playbook)
    await storage.controls.set(K.autonomy(s.promoted_playbook), down, "auto-demote");
  await storage.alerts.raise(
    "autonomy",
    `Graph shape ${fp.slice(0, 12)} dropped ${current} → ${down} after a breach: ${reason}`,
    { fingerprint: fp },
  );
  return { from: current, to: down };
}
