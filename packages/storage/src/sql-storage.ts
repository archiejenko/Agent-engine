import { Claim, VerifiedFact, VerifiedFactVersion } from "@ae/contracts";
import type { SqlDriver, SqlStatement, SqlValue } from "./driver.ts";
import { lettersStorage } from "./letters.ts";
import { phase2 } from "./phase2.ts";
import { phase3 } from "./phase3.ts";
import { phase4 } from "./phase4.ts";
import { phase5 } from "./phase5.ts";
import type {
  EntityRow,
  FactListQuery,
  ProgressStatus,
  Run,
  RunStatus,
  Storage,
  StoredFactVersion,
  UniverseMember,
  UsableClaim,
} from "./storage.ts";

type Row = Record<string, unknown>;

const nowIso = () => new Date().toISOString();
const str = (v: unknown) => v as string;
const parseJson = (v: unknown) => JSON.parse(v as string);
const BATCH = 200;
const IN_CHUNK = 90;

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

function rowToClaim(r: Row): Claim {
  return Claim.parse({
    claim_id: r.claim_id,
    entity_id: r.entity_id ?? null,
    raw_entity_ref: { source_id: r.raw_source_id, name: r.raw_name ?? null },
    field: r.field,
    value: parseJson(r.value),
    source: r.source,
    source_tier: r.source_tier,
    lane: r.lane,
    method: r.method,
    evidence: r.evidence === null ? null : parseJson(r.evidence),
    observed_at: r.observed_at,
    published_at: r.published_at,
    fetched_at: r.fetched_at,
    run_id: r.run_id,
  });
}

function rowToFact(r: Row): VerifiedFact {
  return VerifiedFact.parse({
    entity_id: r.entity_id,
    field: r.field,
    value: parseJson(r.value),
    confidence: r.confidence,
    supporting_claims: parseJson(r.supporting_claims),
    conflicting_claims: parseJson(r.conflicting_claims),
    lane: r.lane,
    valid_from: r.valid_from,
    first_observed_at: r.first_observed_at,
    last_verified_at: r.last_verified_at,
    expires_at: r.expires_at ?? null,
    status: r.status,
  });
}

function rowToVersion(r: Row): StoredFactVersion {
  return VerifiedFactVersion.parse({
    fact: rowToFact(r),
    version: r.version,
    recorded_at: r.recorded_at,
    run_id: r.run_id,
  });
}

function rowToRun(r: Row): Run {
  return {
    run_id: str(r.run_id),
    kind: str(r.kind),
    started_at: str(r.started_at),
    finished_at: (r.finished_at as string | null) ?? null,
    status: r.status as RunStatus,
    config_versions: parseJson(r.config_versions),
  };
}

function rowToEntity(r: Row): EntityRow {
  return {
    entity_id: str(r.entity_id),
    name: str(r.name),
    name_normalised: str(r.name_normalised),
    postcode: (r.postcode as string | null) ?? null,
    lad_code: (r.lad_code as string | null) ?? null,
    company_status: (r.company_status as string | null) ?? null,
    accounts_category: (r.accounts_category as string | null) ?? null,
    sic_codes: parseJson(r.sic_codes),
    charges_count: r.charges_count === null ? null : Number(r.charges_count),
    incorporation_date: (r.incorporation_date as string | null) ?? null,
  };
}

const FACT_COLUMNS =
  "entity_id, field, value, confidence, supporting_claims, conflicting_claims, lane, valid_from, first_observed_at, last_verified_at, expires_at, status";

/** Excludes anything written by a rolled-back run. */
const LIVE_RUN = "run_id NOT IN (SELECT run_id FROM runs WHERE status = 'rolled_back')";

function claimInsertParams(c: Claim, insertedAt: string): SqlValue[] {
  return [
    c.claim_id,
    c.entity_id,
    c.raw_entity_ref.source_id,
    c.raw_entity_ref.name,
    c.field,
    JSON.stringify(c.value),
    c.source,
    c.source_tier,
    c.lane,
    c.method,
    c.evidence === null ? null : JSON.stringify(c.evidence),
    c.observed_at,
    c.published_at,
    c.fetched_at,
    c.run_id,
    insertedAt,
  ];
}
const CLAIM_INSERT_COLS =
  "(claim_id, entity_id, raw_source_id, raw_name, field, value, source, source_tier, lane, method, evidence, observed_at, published_at, fetched_at, run_id, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/** Storage implemented over plain SQL. Works on any SqlDriver (SQLite file or D1). */
export class SqlStorage implements Storage {
  constructor(private readonly db: SqlDriver) {
    Object.assign(this, phase2(db), phase3(db), phase4(db), phase5(db), lettersStorage(db));
  }
  declare signals: Storage["signals"];
  declare moduleRuns: Storage["moduleRuns"];
  declare opportunities: Storage["opportunities"];
  declare tasks: Storage["tasks"];
  declare runLog: Storage["runLog"];
  declare approvals: Storage["approvals"];
  declare examples: Storage["examples"];
  declare controls: Storage["controls"];
  declare alerts: Storage["alerts"];
  declare quarantine: Storage["quarantine"];
  declare golden: Storage["golden"];
  declare outcomes: Storage["outcomes"];
  declare drift: Storage["drift"];
  declare pauses: Storage["pauses"];
  declare backtests: Storage["backtests"];
  declare suggestions: Storage["suggestions"];
  declare margins: Storage["margins"];
  declare x402: Storage["x402"];
  declare ledger: Storage["ledger"];
  declare blind: Storage["blind"];
  declare customers: Storage["customers"];
  declare watches: Storage["watches"];
  declare suppressions: Storage["suppressions"];
  declare outbox: Storage["outbox"];
  declare followups: Storage["followups"];
  declare demoPages: Storage["demoPages"];
  declare letters: Storage["letters"];
  declare printBatches: Storage["printBatches"];

  private async batchChunked(statements: SqlStatement[]) {
    for (const part of chunk(statements, BATCH)) await this.db.batch(part);
  }

  runs = {
    start: async (input: { kind: string; config_versions?: Record<string, string> }) => {
      const run: Run = {
        run_id: crypto.randomUUID(),
        kind: input.kind,
        started_at: nowIso(),
        finished_at: null,
        status: "running",
        config_versions: input.config_versions ?? {},
      };
      await this.db.run(
        "INSERT INTO runs (run_id, kind, started_at, status, config_versions) VALUES (?, ?, ?, ?, ?)",
        [run.run_id, run.kind, run.started_at, run.status, JSON.stringify(run.config_versions)],
      );
      return run;
    },
    finish: async (runId: string, status: Exclude<RunStatus, "running">) => {
      const r = await this.db.run("UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?", [
        status,
        nowIso(),
        runId,
      ]);
      if (r.changes !== 1) throw new Error(`run ${runId} not found`);
    },
    get: async (runId: string) => {
      const rows = await this.db.all<Row>("SELECT * FROM runs WHERE run_id = ?", [runId]);
      return rows[0] ? rowToRun(rows[0]) : null;
    },
  };

  claims = {
    insertMany: async (claims: Claim[]) => {
      const insertedAt = nowIso();
      const statements = claims.map((input) => ({
        sql: `INSERT INTO claims ${CLAIM_INSERT_COLS}`,
        params: claimInsertParams(Claim.parse(input), insertedAt),
      }));
      await this.db.batch(statements); // single transaction: all or nothing
    },
    record: async (claims: Claim[], seen: { run_id: string; fetched_at: string }) => {
      const parsed = claims.map((c) => Claim.parse(c));
      const existing = new Set<string>();
      for (const ids of chunk(
        parsed.map((c) => c.claim_id),
        IN_CHUNK,
      )) {
        const rows = await this.db.all<{ claim_id: string }>(
          `SELECT claim_id FROM claims WHERE claim_id IN (${placeholders(ids.length)})`,
          ids,
        );
        for (const r of rows) existing.add(r.claim_id);
      }
      const insertedAt = nowIso();
      const statements: SqlStatement[] = [];
      for (const c of parsed) {
        if (!existing.has(c.claim_id)) {
          statements.push({
            sql: `INSERT OR IGNORE INTO claims ${CLAIM_INSERT_COLS}`,
            params: claimInsertParams(c, insertedAt),
          });
        }
        statements.push({
          sql: "INSERT OR IGNORE INTO claim_observations (claim_id, run_id, fetched_at) VALUES (?, ?, ?)",
          params: [c.claim_id, seen.run_id, seen.fetched_at],
        });
      }
      await this.batchChunked(statements);
      return { inserted: parsed.filter((c) => !existing.has(c.claim_id)).length };
    },
    get: async (claimId: string) => {
      const rows = await this.db.all<Row>("SELECT * FROM claims WHERE claim_id = ?", [claimId]);
      return rows[0] ? rowToClaim(rows[0]) : null;
    },
    listForEntityField: async (entityId: string, field: string) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM claims WHERE entity_id = ? AND field = ? ORDER BY published_at, claim_id",
        [entityId, field],
      );
      return rows.map(rowToClaim);
    },
    listUsable: async (entityId: string, field: string): Promise<UsableClaim[]> => {
      return this.claims.listUsableFor([entityId], [field]);
    },
    listUsableFor: async (entityIds: string[] | null, fields: string[]): Promise<UsableClaim[]> => {
      const base = `SELECT c.* FROM claims c
         WHERE c.field IN (${placeholders(fields.length)})
           AND c.entity_id IS NOT NULL
           AND c.claim_id NOT IN (SELECT claim_id FROM claim_supersessions)
           AND c.claim_id NOT IN (SELECT claim_id FROM claim_rejections)
           AND c.${LIVE_RUN}`;
      const rows: Row[] = [];
      if (entityIds === null) {
        rows.push(
          ...(await this.db.all<Row>(
            `${base} ORDER BY c.entity_id, c.field, c.published_at, c.claim_id`,
            fields,
          )),
        );
      } else {
        for (const ids of chunk(entityIds, IN_CHUNK - fields.length)) {
          rows.push(
            ...(await this.db.all<Row>(
              `${base} AND c.entity_id IN (${placeholders(ids.length)}) ORDER BY c.entity_id, c.field, c.published_at, c.claim_id`,
              [...fields, ...ids],
            )),
          );
        }
      }
      if (rows.length === 0) return [];
      const claims = rows.map(rowToClaim);
      const obs = new Map<string, string[]>();
      for (const ids of chunk(
        claims.map((c) => c.claim_id),
        IN_CHUNK,
      )) {
        const o = await this.db.all<{ claim_id: string; fetched_at: string }>(
          `SELECT claim_id, fetched_at FROM claim_observations
           WHERE claim_id IN (${placeholders(ids.length)}) AND ${LIVE_RUN} ORDER BY fetched_at`,
          ids,
        );
        for (const r of o) obs.set(r.claim_id, [...(obs.get(r.claim_id) ?? []), r.fetched_at]);
      }
      return claims.map((claim) => ({
        claim,
        observations: obs.get(claim.claim_id) ?? [claim.fetched_at],
      }));
    },
    listByRun: async (runId: string) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM claims WHERE run_id = ? ORDER BY claim_id",
        [runId],
      );
      return rows.map(rowToClaim);
    },
    touchedByRun: async (runId: string) => {
      return this.db.all<{ entity_id: string; field: string }>(
        `SELECT DISTINCT entity_id, field FROM claims
         WHERE entity_id IS NOT NULL AND (run_id = ?
           OR claim_id IN (SELECT claim_id FROM claim_observations WHERE run_id = ?))
         ORDER BY entity_id, field`,
        [runId, runId],
      );
    },
    supersede: async (claimIds: string[], reason: string, byRunId: string | null) => {
      const at = nowIso();
      await this.batchChunked(
        claimIds.map((id) => ({
          sql: "INSERT OR IGNORE INTO claim_supersessions (claim_id, superseded_at, reason, by_run_id) VALUES (?, ?, ?, ?)",
          params: [id, at, reason, byRunId],
        })),
      );
    },
    isSuperseded: async (claimId: string) => {
      const rows = await this.db.all("SELECT 1 FROM claim_supersessions WHERE claim_id = ?", [
        claimId,
      ]);
      return rows.length > 0;
    },
    reject: async (rejections: { claim_id: string; rule: string; detail: string }[]) => {
      const at = nowIso();
      await this.batchChunked(
        rejections.map((r) => ({
          sql: "INSERT OR IGNORE INTO claim_rejections (claim_id, rule, detail, rejected_at) VALUES (?, ?, ?, ?)",
          params: [r.claim_id, r.rule, r.detail, at],
        })),
      );
    },
    listRejections: async (limit: number) => {
      return this.db.all<{ claim_id: string; rule: string; detail: string }>(
        "SELECT claim_id, rule, detail FROM claim_rejections ORDER BY rejected_at DESC, claim_id LIMIT ?",
        [limit],
      );
    },
  };

  facts = {
    put: async (input: VerifiedFact, meta: { run_id: string; recorded_at: string }) => {
      const f = VerifiedFact.parse(input);
      const values: SqlValue[] = [
        f.entity_id,
        f.field,
        JSON.stringify(f.value),
        f.confidence,
        JSON.stringify(f.supporting_claims),
        JSON.stringify(f.conflicting_claims),
        f.lane,
        f.valid_from,
        f.first_observed_at,
        f.last_verified_at,
        f.expires_at,
        f.status,
      ];
      const nextVersion =
        "(SELECT COALESCE(MAX(version), 0) + 1 FROM verified_fact_versions WHERE entity_id = ? AND field = ?)";
      await this.db.batch([
        {
          sql: `INSERT INTO verified_fact_versions (${FACT_COLUMNS}, version, recorded_at, run_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nextVersion}, ?, ?)`,
          params: [...values, f.entity_id, f.field, meta.recorded_at, meta.run_id],
        },
        {
          sql: `INSERT INTO verified_facts (${FACT_COLUMNS}, version)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  (SELECT MAX(version) FROM verified_fact_versions WHERE entity_id = ? AND field = ?))
                ON CONFLICT (entity_id, field) DO UPDATE SET
                  value = excluded.value, confidence = excluded.confidence,
                  supporting_claims = excluded.supporting_claims, conflicting_claims = excluded.conflicting_claims,
                  lane = excluded.lane, valid_from = excluded.valid_from, first_observed_at = excluded.first_observed_at,
                  last_verified_at = excluded.last_verified_at, expires_at = excluded.expires_at,
                  status = excluded.status, version = excluded.version`,
          params: [...values, f.entity_id, f.field],
        },
      ]);
      const rows = await this.db.all<{ version: number }>(
        "SELECT version FROM verified_facts WHERE entity_id = ? AND field = ?",
        [f.entity_id, f.field],
      );
      return Number(rows[0]?.version);
    },
    touch: async (
      entityId: string,
      field: string,
      patch: {
        last_verified_at: string;
        confidence: number;
        expires_at: string | null;
        status: VerifiedFact["status"];
      },
    ) => {
      if (patch.confidence < 0 || patch.confidence > 1)
        throw new Error("confidence must be within 0-1");
      await this.db.run(
        "UPDATE verified_facts SET last_verified_at = ?, confidence = ?, expires_at = ?, status = ? WHERE entity_id = ? AND field = ?",
        [patch.last_verified_at, patch.confidence, patch.expires_at, patch.status, entityId, field],
      );
    },
    removeCurrent: async (entityId: string, field: string) => {
      await this.db.run("DELETE FROM verified_facts WHERE entity_id = ? AND field = ?", [
        entityId,
        field,
      ]);
    },
    getCurrent: async (entityId: string, field: string) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM verified_facts WHERE entity_id = ? AND field = ?",
        [entityId, field],
      );
      return rows[0] ? rowToFact(rows[0]) : null;
    },
    listVersions: async (entityId: string, field: string) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM verified_fact_versions WHERE entity_id = ? AND field = ? ORDER BY version",
        [entityId, field],
      );
      return rows.map(rowToVersion);
    },
    listVersionsFor: async (entityIds: string[] | null, fields: string[]) => {
      const out: StoredFactVersion[] = [];
      const fieldIn = `field IN (${placeholders(fields.length)})`;
      if (entityIds === null) {
        const rows = await this.db.all<Row>(
          `SELECT * FROM verified_fact_versions WHERE ${fieldIn} AND ${LIVE_RUN} ORDER BY entity_id, field, version`,
          fields,
        );
        return rows.map(rowToVersion);
      }
      for (const ids of chunk(entityIds, IN_CHUNK - fields.length)) {
        const rows = await this.db.all<Row>(
          `SELECT * FROM verified_fact_versions
           WHERE entity_id IN (${placeholders(ids.length)}) AND ${fieldIn} AND ${LIVE_RUN}
           ORDER BY entity_id, field, version`,
          [...ids, ...fields],
        );
        out.push(...rows.map(rowToVersion));
      }
      return out;
    },
    listCurrent: async (q: FactListQuery) => {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.entityId) {
        where.push("f.entity_id = ?");
        params.push(q.entityId);
      }
      if (q.field) {
        where.push("f.field = ?");
        params.push(q.field);
      }
      if (q.status) {
        where.push("f.status = ?");
        params.push(q.status);
      }
      if (q.search) {
        where.push(
          "(f.entity_id = ? OR f.entity_id IN (SELECT entity_id FROM entities WHERE name_normalised LIKE ?))",
        );
        params.push(q.search.toUpperCase(), `%${q.search.toUpperCase()}%`);
      }
      const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const total = await this.db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM verified_facts f ${w}`,
        params,
      );
      const rows = await this.db.all<Row>(
        `SELECT f.* FROM verified_facts f ${w} ORDER BY f.entity_id, f.field LIMIT ? OFFSET ?`,
        [...params, q.limit, q.offset],
      );
      return { rows: rows.map(rowToFact), total: Number(total[0]?.n ?? 0) };
    },
    countCurrent: async () => {
      const rows = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM verified_facts");
      return Number(rows[0]?.n ?? 0);
    },
    countByStatus: async () => {
      const rows = await this.db.all<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM verified_facts GROUP BY status ORDER BY status",
      );
      return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
    },
  };

  entities = {
    upsertMany: async (rows: EntityRow[], runId: string) => {
      const at = nowIso();
      await this.batchChunked(
        rows.map((e) => ({
          sql: `INSERT INTO entities (entity_id, name, name_normalised, postcode, lad_code, company_status, accounts_category, sic_codes, charges_count, incorporation_date, source_run_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (entity_id) DO UPDATE SET name = excluded.name, name_normalised = excluded.name_normalised,
                  postcode = excluded.postcode, lad_code = excluded.lad_code, company_status = excluded.company_status,
                  accounts_category = excluded.accounts_category, sic_codes = excluded.sic_codes,
                  charges_count = excluded.charges_count, incorporation_date = excluded.incorporation_date,
                  source_run_id = excluded.source_run_id, updated_at = excluded.updated_at`,
          params: [
            e.entity_id,
            e.name,
            e.name_normalised,
            e.postcode,
            e.lad_code,
            e.company_status,
            e.accounts_category,
            JSON.stringify(e.sic_codes),
            e.charges_count,
            e.incorporation_date,
            runId,
            at,
          ],
        })),
      );
    },
    get: async (entityId: string) => {
      const rows = await this.db.all<Row>("SELECT * FROM entities WHERE entity_id = ?", [entityId]);
      return rows[0] ? rowToEntity(rows[0]) : null;
    },
    count: async () => {
      const rows = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM entities");
      return Number(rows[0]?.n ?? 0);
    },
    findCandidates: async (q: { nameNormalised?: string; postcode?: string; limit: number }) => {
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (q.nameNormalised) {
        where.push("name_normalised = ?");
        params.push(q.nameNormalised);
      }
      if (q.postcode) {
        where.push("postcode = ?");
        params.push(q.postcode);
      }
      if (where.length === 0) return [];
      const rows = await this.db.all<Row>(
        `SELECT * FROM entities WHERE ${where.join(" OR ")} ORDER BY entity_id LIMIT ?`,
        [...params, q.limit],
      );
      return rows.map(rowToEntity);
    },
  };

  universe = {
    setMany: async (rows: UniverseMember[], runId: string) => {
      const at = nowIso();
      await this.batchChunked(
        rows.map((u) => ({
          sql: `INSERT INTO universe_members (universe, entity_id, included, reason, staff_flag, run_id, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (universe, entity_id) DO UPDATE SET included = excluded.included, reason = excluded.reason,
                  staff_flag = excluded.staff_flag, run_id = excluded.run_id, decided_at = excluded.decided_at`,
          params: [u.universe, u.entity_id, u.included ? 1 : 0, u.reason, u.staff_flag, runId, at],
        })),
      );
    },
    list: async (
      universe: string,
      opts: { included?: boolean; limit?: number; offset?: number },
    ) => {
      const params: SqlValue[] = [universe];
      let w = "universe = ?";
      if (opts.included !== undefined) {
        w += " AND included = ?";
        params.push(opts.included ? 1 : 0);
      }
      const rows = await this.db.all<Row>(
        `SELECT * FROM universe_members WHERE ${w} ORDER BY entity_id LIMIT ? OFFSET ?`,
        [...params, opts.limit ?? 1_000_000, opts.offset ?? 0],
      );
      return rows.map((r) => ({
        universe: str(r.universe),
        entity_id: str(r.entity_id),
        included: Number(r.included) === 1,
        reason: str(r.reason),
        staff_flag: r.staff_flag as UniverseMember["staff_flag"],
      }));
    },
    counts: async (universe: string) => {
      const rows = await this.db.all<{ included: number; excluded: number; staff_unknown: number }>(
        `SELECT COALESCE(SUM(included), 0) AS included, COALESCE(SUM(1 - included), 0) AS excluded,
                COALESCE(SUM(CASE WHEN included = 1 AND staff_flag = 'staff_unknown' THEN 1 ELSE 0 END), 0) AS staff_unknown
         FROM universe_members WHERE universe = ?`,
        [universe],
      );
      const r = rows[0];
      return {
        included: Number(r?.included ?? 0),
        excluded: Number(r?.excluded ?? 0),
        staff_unknown: Number(r?.staff_unknown ?? 0),
      };
    },
  };

  progress = {
    ensure: async (job: string, entityIds: string[], steps: string[]) => {
      const at = nowIso();
      const stmts: SqlStatement[] = [];
      for (const e of entityIds) {
        for (const s of steps) {
          stmts.push({
            sql: "INSERT OR IGNORE INTO ingest_progress (job, entity_id, step, status, attempts, updated_at) VALUES (?, ?, ?, 'pending', 0, ?)",
            params: [job, e, s, at],
          });
        }
      }
      await this.batchChunked(stmts);
    },
    next: async (job: string, limit: number, maxAttempts: number) => {
      const rows = await this.db.all<{ entity_id: string; step: string; attempts: number }>(
        `SELECT entity_id, step, attempts FROM ingest_progress
         WHERE job = ? AND (status = 'pending' OR (status = 'failed' AND attempts < ?))
         ORDER BY entity_id, step LIMIT ?`,
        [job, maxAttempts, limit],
      );
      return rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
    },
    mark: async (
      job: string,
      entityId: string,
      step: string,
      status: ProgressStatus,
      error?: string,
    ) => {
      await this.db.run(
        `UPDATE ingest_progress SET status = ?, attempts = attempts + ?, last_error = ?, updated_at = ?
         WHERE job = ? AND entity_id = ? AND step = ?`,
        [status, status === "failed" ? 1 : 0, error ?? null, nowIso(), job, entityId, step],
      );
    },
    summary: async (job: string) => {
      const rows = await this.db.all<{ status: ProgressStatus; n: number }>(
        "SELECT status, COUNT(*) AS n FROM ingest_progress WHERE job = ? GROUP BY status",
        [job],
      );
      const out: Record<ProgressStatus, number> = { pending: 0, done: 0, failed: 0, skipped: 0 };
      for (const r of rows) out[r.status] = Number(r.n);
      return out;
    },
  };

  verificationRequests = {
    add: async (
      rows: { entity_id: string; field: string; reason: string; deadline: string | null }[],
    ) => {
      const at = nowIso();
      await this.batchChunked(
        rows.map((r) => ({
          sql: "INSERT INTO verification_requests (request_id, entity_id, field, reason, deadline, requested_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: [crypto.randomUUID(), r.entity_id, r.field, r.reason, r.deadline, at],
        })),
      );
    },
    listOpen: async (limit: number) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM verification_requests WHERE processed_at IS NULL ORDER BY requested_at, request_id LIMIT ?",
        [limit],
      );
      return rows.map((r) => ({
        request_id: str(r.request_id),
        entity_id: str(r.entity_id),
        field: str(r.field),
        reason: str(r.reason),
        deadline: (r.deadline as string | null) ?? null,
        requested_at: str(r.requested_at),
      }));
    },
    markProcessed: async (requestIds: string[]) => {
      const at = nowIso();
      await this.batchChunked(
        requestIds.map((id) => ({
          sql: "UPDATE verification_requests SET processed_at = ? WHERE request_id = ?",
          params: [at, id],
        })),
      );
    },
  };

  dropped = {
    record: async (source: string, sourceField: string, runId: string, occurrences: number) => {
      await this.db.run(
        `INSERT INTO dropped_fields (source, source_field, run_id, occurrences, first_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (source, source_field, run_id) DO UPDATE SET occurrences = occurrences + excluded.occurrences`,
        [source, sourceField, runId, occurrences, nowIso()],
      );
    },
    list: async (runId?: string) => {
      const rows = await this.db.all<Row>(
        `SELECT source, source_field, run_id, occurrences FROM dropped_fields ${runId ? "WHERE run_id = ?" : ""} ORDER BY source, source_field`,
        runId ? [runId] : [],
      );
      return rows.map((r) => ({
        source: str(r.source),
        source_field: str(r.source_field),
        run_id: str(r.run_id),
        occurrences: Number(r.occurrences),
      }));
    },
  };

  stats = {
    counts: async () => {
      const one = async (sql: string) => Number((await this.db.all<{ n: number }>(sql))[0]?.n ?? 0);
      const rej = await this.db.all<{ rule: string; n: number }>(
        "SELECT rule, COUNT(*) AS n FROM claim_rejections GROUP BY rule ORDER BY rule",
      );
      const runs = await this.db.all<{ status: string; n: number }>(
        "SELECT status, COUNT(*) AS n FROM runs GROUP BY status ORDER BY status",
      );
      return {
        claims: await one("SELECT COUNT(*) AS n FROM claims"),
        observations: await one("SELECT COUNT(*) AS n FROM claim_observations"),
        rejections: Object.fromEntries(rej.map((r) => [r.rule, Number(r.n)])),
        entities: await one("SELECT COUNT(*) AS n FROM entities"),
        runs: Object.fromEntries(runs.map((r) => [r.status, Number(r.n)])),
      };
    },
    universeReasons: async (universe: string) => {
      const rows = await this.db.all<{ reason: string; n: number }>(
        "SELECT reason, COUNT(*) AS n FROM universe_members WHERE universe = ? GROUP BY reason ORDER BY n DESC, reason",
        [universe],
      );
      return Object.fromEntries(rows.map((r) => [r.reason, Number(r.n)]));
    },
    unanchoredMembers: async (universe: string) => {
      const rows = await this.db.all<{ entity_id: string }>(
        `SELECT u.entity_id FROM universe_members u
         WHERE u.universe = ? AND u.included = 1
           AND NOT EXISTS (SELECT 1 FROM verified_facts f WHERE f.entity_id = u.entity_id)
         ORDER BY u.entity_id`,
        [universe],
      );
      return rows.map((r) => r.entity_id);
    },
  };

  async health() {
    try {
      const rows = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM d1_migrations");
      return { ok: true, migrations: Number(rows[0]?.n ?? 0) };
    } catch {
      return { ok: false, migrations: 0 };
    }
  }

  async close() {
    await this.db.close();
  }
}
