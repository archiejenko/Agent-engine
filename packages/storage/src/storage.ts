import type { Claim, VerifiedFact, VerifiedFactVersion } from "@ae/contracts";
import type { Phase2Storage } from "./phase2.ts";
import type { Phase3Storage } from "./phase3.ts";

export type RunStatus = "running" | "succeeded" | "failed" | "rolled_back";

export interface Run {
  run_id: string;
  kind: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  config_versions: Record<string, string>;
}

/** A claim that still counts: not superseded, not rejected, not from a rolled-back run. */
export interface UsableClaim {
  claim: Claim;
  /** fetched_at of every observation of this claim from runs that were not rolled back. */
  observations: string[];
}

/** A stored fact version plus who wrote it and when. Rolled-back runs are already excluded. */
export interface StoredFactVersion extends VerifiedFactVersion {}

export interface EntityRow {
  entity_id: string;
  name: string;
  name_normalised: string;
  postcode: string | null;
  lad_code: string | null;
  company_status: string | null;
  accounts_category: string | null;
  sic_codes: string[];
  charges_count: number | null;
  incorporation_date: string | null;
}

export interface UniverseMember {
  universe: string;
  entity_id: string;
  included: boolean;
  reason: string;
  staff_flag: "known" | "staff_unknown" | "not_checked";
}

export type ProgressStatus = "pending" | "done" | "failed" | "skipped";

export interface FactListQuery {
  search?: string;
  entityId?: string;
  field?: string;
  status?: string;
  limit: number;
  offset: number;
}

/**
 * The Storage interface. Engines, apps and scripts talk to this, never to a database.
 * Every value is validated against its contract on the way in and on the way out.
 */
export interface Storage extends Phase2Storage, Phase3Storage {
  runs: {
    start(input: { kind: string; config_versions?: Record<string, string> }): Promise<Run>;
    finish(runId: string, status: Exclude<RunStatus, "running">): Promise<void>;
    get(runId: string): Promise<Run | null>;
  };
  claims: {
    /** Append claims (validated). Atomic: all or none. Fails on duplicates. */
    insertMany(claims: Claim[]): Promise<void>;
    /**
     * Record claims seen by a run: new claims are appended, claims we already hold (same id) get an
     * observation instead of a duplicate. Returns how many were new.
     */
    record(
      claims: Claim[],
      seen: { run_id: string; fetched_at: string },
    ): Promise<{ inserted: number }>;
    get(claimId: string): Promise<Claim | null>;
    listForEntityField(entityId: string, field: string): Promise<Claim[]>;
    listUsable(entityId: string, field: string): Promise<UsableClaim[]>;
    /** Bulk version of listUsable. entityIds = null means every entity. */
    listUsableFor(entityIds: string[] | null, fields: string[]): Promise<UsableClaim[]>;
    listByRun(runId: string): Promise<Claim[]>;
    /** Entity + field pairs touched by a run (claims first inserted or observed by it). */
    touchedByRun(runId: string): Promise<{ entity_id: string; field: string }[]>;
    supersede(claimIds: string[], reason: string, byRunId: string | null): Promise<void>;
    isSuperseded(claimId: string): Promise<boolean>;
    reject(rejections: { claim_id: string; rule: string; detail: string }[]): Promise<void>;
    listRejections(limit: number): Promise<{ claim_id: string; rule: string; detail: string }[]>;
  };
  facts: {
    /** Write a new version of a fact and make it current. Returns the version number. */
    put(fact: VerifiedFact, meta: { run_id: string; recorded_at: string }): Promise<number>;
    /** Update re-verification details on the current row without creating a new version. */
    touch(
      entityId: string,
      field: string,
      patch: {
        last_verified_at: string;
        confidence: number;
        expires_at: string | null;
        status: VerifiedFact["status"];
      },
    ): Promise<void>;
    /** Remove the current row (history is kept). Used when every supporting claim is withdrawn. */
    removeCurrent(entityId: string, field: string): Promise<void>;
    getCurrent(entityId: string, field: string): Promise<VerifiedFact | null>;
    listVersions(entityId: string, field: string): Promise<StoredFactVersion[]>;
    /** Versions for many entities/fields, excluding versions written by rolled-back runs. */
    listVersionsFor(entityIds: string[] | null, fields: string[]): Promise<StoredFactVersion[]>;
    listCurrent(q: FactListQuery): Promise<{ rows: VerifiedFact[]; total: number }>;
    countCurrent(): Promise<number>;
    countByStatus(): Promise<Record<string, number>>;
  };
  entities: {
    upsertMany(rows: EntityRow[], runId: string): Promise<void>;
    get(entityId: string): Promise<EntityRow | null>;
    count(): Promise<number>;
    findCandidates(q: {
      nameNormalised?: string;
      postcode?: string;
      limit: number;
    }): Promise<EntityRow[]>;
  };
  universe: {
    setMany(rows: UniverseMember[], runId: string): Promise<void>;
    list(
      universe: string,
      opts: { included?: boolean; limit?: number; offset?: number },
    ): Promise<UniverseMember[]>;
    counts(
      universe: string,
    ): Promise<{ included: number; excluded: number; staff_unknown: number }>;
  };
  progress: {
    ensure(job: string, entityIds: string[], steps: string[]): Promise<void>;
    /** Work still to do: pending, or failed with fewer than maxAttempts attempts. */
    next(
      job: string,
      limit: number,
      maxAttempts: number,
    ): Promise<{ entity_id: string; step: string; attempts: number }[]>;
    mark(
      job: string,
      entityId: string,
      step: string,
      status: ProgressStatus,
      error?: string,
    ): Promise<void>;
    summary(job: string): Promise<Record<ProgressStatus, number>>;
  };
  verificationRequests: {
    add(
      rows: { entity_id: string; field: string; reason: string; deadline: string | null }[],
    ): Promise<void>;
    listOpen(limit: number): Promise<
      {
        request_id: string;
        entity_id: string;
        field: string;
        reason: string;
        deadline: string | null;
        requested_at: string;
      }[]
    >;
    markProcessed(requestIds: string[]): Promise<void>;
  };
  dropped: {
    record(source: string, sourceField: string, runId: string, occurrences: number): Promise<void>;
    list(
      runId?: string,
    ): Promise<{ source: string; source_field: string; run_id: string; occurrences: number }[]>;
  };
  stats: {
    counts(): Promise<{
      claims: number;
      observations: number;
      rejections: Record<string, number>;
      entities: number;
      runs: Record<string, number>;
    }>;
    universeReasons(universe: string): Promise<Record<string, number>>;
    /** Universe members (included) with no current facts at all: should be zero (100% anchored). */
    unanchoredMembers(universe: string): Promise<string[]>;
  };
  health(): Promise<{ ok: boolean; migrations: number }>;
  close(): Promise<void>;
}
