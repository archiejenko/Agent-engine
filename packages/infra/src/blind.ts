import type { LedgerRow, StoredTask } from "@ae/storage";

/**
 * Blind views (v2 D4, v3 rule 22): every company, task and message view hides whether something belongs
 * to the ranked arm or the random holdout. One place for it, used by Review, CRM and Inbox.
 */
export const entityOfRef = (ref: string) => ref.split(":").pop() ?? ref;

export type BlindTask = Omit<StoredTask, "state"> & { state: Record<string, unknown> };

export function blindTask(t: StoredTask): BlindTask {
  const { cohort: _cohort, ...state } = t.state as Record<string, unknown>;
  const ref = `entity:${entityOfRef(t.source_ref)}`;
  return { ...t, source_ref: ref, idempotency_key: ref, state };
}

export type BlindLedgerRow = Omit<LedgerRow, "arm" | "cohort_id">;

export function blindLedgerRow(r: LedgerRow): BlindLedgerRow {
  const { arm: _arm, cohort_id: _cohort, ...rest } = r;
  return rest;
}

/** For tests: a JSON body that mentions the holdout, an arm or a cohort leaks the assignment. */
export const LEAKS_ARM = /holdout|"arm"|cohort/i;
