import type { Claim, VerifiedFact, VerifiedFactVersion } from "@ae/contracts";

export type RunStatus = "running" | "succeeded" | "failed" | "rolled_back";

export interface Run {
  run_id: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  config_versions: Record<string, string>;
}

/**
 * The Storage interface. Engines, apps and scripts talk to this, never to a database.
 * Every value is validated against its contract on the way in and on the way out.
 * Grows phase by phase; Phase 0 covers runs, claims and versioned facts.
 */
export interface Storage {
  runs: {
    start(input: { kind: string; config_versions?: Record<string, string> }): Promise<Run>;
    finish(runId: string, status: Exclude<RunStatus, "running">): Promise<void>;
    get(runId: string): Promise<Run | null>;
  };
  claims: {
    /** Append claims (validated). Atomic: all or none. */
    insertMany(claims: Claim[]): Promise<void>;
    get(claimId: string): Promise<Claim | null>;
    listForEntityField(entityId: string, field: string): Promise<Claim[]>;
    listByRun(runId: string): Promise<Claim[]>;
    /** Mark claims as superseded (they stay in the table forever). */
    supersede(claimIds: string[], reason: string, byRunId: string | null): Promise<void>;
    isSuperseded(claimId: string): Promise<boolean>;
  };
  facts: {
    /** Write a new version of a fact and make it current. Returns the version number. */
    put(fact: VerifiedFact, meta: { run_id: string; recorded_at: string }): Promise<number>;
    getCurrent(entityId: string, field: string): Promise<VerifiedFact | null>;
    listVersions(entityId: string, field: string): Promise<VerifiedFactVersion[]>;
    countCurrent(): Promise<number>;
  };
  health(): Promise<{ ok: boolean; migrations: number }>;
  close(): Promise<void>;
}
