import type { InfraConfig } from "@ae/config";
import { type FunnelEvent, LedgerEvent, type LedgerSource } from "@ae/contracts";
import type { Storage, StoredTask } from "@ae/storage";
import { estimatePaid } from "./ev.ts";

/**
 * Writing to the outcome ledger (v2 Phase 1). Every event is attributed to the task that earned it,
 * with its playbook version, cohort arm and synthetic flag copied from the task, so lift, margin and
 * learning can all be computed from this one table. Recording is idempotent on `dedupe_key`.
 */
export interface Attribution {
  task_id: string | null;
  playbook: string | null;
  playbook_version: number | null;
  cohort_id: string | null;
  arm: "ranked" | "holdout" | null;
  experiment_id: string | null;
  hypothesis_id: string | null;
  opportunity_id: string | null;
  synthetic: boolean;
}

export function attributionFromTask(task: StoredTask | null): Attribution {
  const st = (task?.state ?? {}) as {
    cohort?: { id: string; arm: "ranked" | "holdout" };
    experiment_id?: string;
    hypothesis_id?: string;
  };
  return {
    task_id: task?.task_id ?? null,
    playbook: task?.playbook ?? null,
    playbook_version: task?.playbook_version ?? null,
    cohort_id: st.cohort?.id ?? null,
    arm: st.cohort?.arm ?? null,
    experiment_id: st.experiment_id ?? null,
    hypothesis_id: st.hypothesis_id ?? null,
    opportunity_id: task?.source_ref.match(/^opportunity:([^:]+)/)?.[1] ?? null,
    synthetic: task?.synthetic ?? false,
  };
}

/** The outreach task that most recently contacted a company (for attributing replies and payments). */
export async function lastOutreachTask(
  storage: Storage,
  cfg: InfraConfig,
  entityId: string,
): Promise<StoredTask | null> {
  const tasks = (await storage.tasks.forEntity(entityId)).filter((t) =>
    cfg.outreach.contact_playbooks.includes(t.playbook),
  );
  return tasks[0] ?? null;
}

/** Events that move money record the actual amount; the rest record an estimate with its assumption. */
const MONEY: FunnelEvent[] = ["paid", "refunded", "churned", "checkout_started"];

export async function recordOutcome(
  storage: Storage,
  cfg: InfraConfig,
  e: {
    event: FunnelEvent;
    entity_id: string;
    task?: StoredTask | null;
    source: LedgerSource;
    dedupe_key: string;
    observed_at?: string;
    /** Actual £ for money events. */
    value_gbp?: number | null;
    ms_on_page?: number | null;
    dry_run?: boolean;
    /** Forces the synthetic flag (the simulator); otherwise copied from the task. */
    synthetic?: boolean;
  },
): Promise<boolean> {
  const a = attributionFromTask(e.task ?? null);
  let value_gbp: number | null = e.value_gbp ?? null;
  let value_kind: "actual" | "estimate" = "actual";
  let assumption: string | null = null;
  if (!MONEY.includes(e.event) && a.playbook) {
    // Expected £ at this stage of the funnel, from the current P(paid) estimate (labelled assumption).
    const est = await estimatePaid(storage, cfg, a.playbook, e.observed_at);
    const fyv = cfg.measurement.priors.first_year_value_gbp;
    const p =
      e.event === "reply" || e.event === "reply_positive" || e.event === "booking"
        ? est.p_close
        : est.p_paid;
    value_gbp = Number((p * fyv).toFixed(4));
    value_kind = "estimate";
    assumption = `${e.event === "reply" || e.event === "reply_positive" || e.event === "booking" ? "P(paid | reply)" : "P(paid)"} ${p.toFixed(4)} × first-year value £${fyv} (${est.basis})`;
  }
  return storage.outcomeLedger.record(
    LedgerEvent.parse({
      event: e.event,
      entity_id: e.entity_id,
      task_id: a.task_id,
      playbook: a.playbook,
      playbook_version: a.playbook_version,
      opportunity_id: a.opportunity_id,
      experiment_id: a.experiment_id,
      hypothesis_id: a.hypothesis_id,
      cohort_id: a.cohort_id,
      arm: a.arm,
      value_gbp,
      value_kind,
      assumption,
      ms_on_page: e.ms_on_page ?? null,
      observed_at: e.observed_at ?? new Date().toISOString(),
      source: e.source,
      synthetic: e.synthetic ?? a.synthetic,
      dry_run: e.dry_run ?? false,
      dedupe_key: e.dedupe_key,
    }),
  );
}
