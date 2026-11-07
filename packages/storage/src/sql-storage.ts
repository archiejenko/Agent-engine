import { Claim, VerifiedFact, VerifiedFactVersion } from "@ae/contracts";
import type { SqlDriver } from "./driver.ts";
import type { Run, RunStatus, Storage } from "./storage.ts";

type Row = Record<string, unknown>;

const nowIso = () => new Date().toISOString();
const str = (v: unknown) => v as string;
const parseJson = (v: unknown) => JSON.parse(v as string);

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
    effective_from: r.effective_from,
    last_verified_at: r.last_verified_at,
    expires_at: r.expires_at ?? null,
    status: r.status,
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

const FACT_COLUMNS =
  "entity_id, field, value, confidence, supporting_claims, conflicting_claims, lane, valid_from, effective_from, last_verified_at, expires_at, status";

/** Storage implemented over plain SQL. Works on any SqlDriver (SQLite file or D1). */
export class SqlStorage implements Storage {
  constructor(private readonly db: SqlDriver) {}

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
      const statements = claims.map((input) => {
        const c = Claim.parse(input); // contract enforced at the boundary
        return {
          sql: `INSERT INTO claims (claim_id, entity_id, raw_source_id, raw_name, field, value, source, source_tier, lane, method, evidence, observed_at, published_at, fetched_at, run_id, inserted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
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
          ],
        };
      });
      await this.db.batch(statements);
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
    listByRun: async (runId: string) => {
      const rows = await this.db.all<Row>(
        "SELECT * FROM claims WHERE run_id = ? ORDER BY claim_id",
        [runId],
      );
      return rows.map(rowToClaim);
    },
    supersede: async (claimIds: string[], reason: string, byRunId: string | null) => {
      const at = nowIso();
      await this.db.batch(
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
  };

  facts = {
    put: async (input: VerifiedFact, meta: { run_id: string; recorded_at: string }) => {
      const f = VerifiedFact.parse(input);
      const values = [
        f.entity_id,
        f.field,
        JSON.stringify(f.value),
        f.confidence,
        JSON.stringify(f.supporting_claims),
        JSON.stringify(f.conflicting_claims),
        f.lane,
        f.valid_from,
        f.effective_from,
        f.last_verified_at,
        f.expires_at,
        f.status,
      ];
      const nextVersion =
        "(SELECT COALESCE(MAX(version), 0) + 1 FROM verified_fact_versions WHERE entity_id = ? AND field = ?)";
      // Version row first, then the current row pointing at that same version; one transaction.
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
                  lane = excluded.lane, valid_from = excluded.valid_from, effective_from = excluded.effective_from,
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
      return rows.map((r) =>
        VerifiedFactVersion.parse({
          fact: rowToFact(r),
          version: r.version,
          recorded_at: r.recorded_at,
          run_id: r.run_id,
        }),
      );
    },
    countCurrent: async () => {
      const rows = await this.db.all<{ n: number }>("SELECT COUNT(*) AS n FROM verified_facts");
      return Number(rows[0]?.n ?? 0);
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
