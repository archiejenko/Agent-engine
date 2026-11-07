-- 0001_core: runs, claims (append-only), verified facts with full version history.
-- Plain SQL, runs unchanged on local SQLite and Cloudflare D1 (wrangler d1 migrations format).
-- JSON values are stored as TEXT. Timestamps are ISO 8601 TEXT in UTC.

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rolled_back')),
  config_versions TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  entity_id TEXT,
  raw_source_id TEXT NOT NULL,
  raw_name TEXT,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT NOT NULL,
  source_tier INTEGER NOT NULL CHECK (source_tier BETWEEN 1 AND 5),
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  method TEXT NOT NULL CHECK (method IN ('api', 'bulk_file', 'scrape', 'llm_extract', 'human')),
  evidence TEXT,
  observed_at TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  inserted_at TEXT NOT NULL
);

CREATE INDEX claims_entity_field ON claims (entity_id, field);

CREATE INDEX claims_run ON claims (run_id);

-- Guardrail: claims are append-only. They are never edited or deleted, only superseded.
CREATE TRIGGER claims_no_update BEFORE UPDATE ON claims
BEGIN
  SELECT RAISE(ABORT, 'claims are append-only');
END;

CREATE TRIGGER claims_no_delete BEFORE DELETE ON claims
BEGIN
  SELECT RAISE(ABORT, 'claims are append-only');
END;

CREATE TABLE claim_supersessions (
  claim_id TEXT PRIMARY KEY REFERENCES claims (claim_id),
  superseded_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  by_run_id TEXT REFERENCES runs (run_id)
);

-- Claims that failed a sanity rule are kept, with the rule that failed.
CREATE TABLE claim_rejections (
  claim_id TEXT PRIMARY KEY REFERENCES claims (claim_id),
  rule TEXT NOT NULL,
  detail TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

-- Current answer per entity + field.
CREATE TABLE verified_facts (
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  supporting_claims TEXT NOT NULL,
  conflicting_claims TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  valid_from TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'conflict', 'stale', 'quarantined')),
  version INTEGER NOT NULL,
  PRIMARY KEY (entity_id, field)
);

CREATE INDEX verified_facts_field ON verified_facts (field, status);

-- Every version ever written. recorded_at = when we wrote it (strict point-in-time mode).
CREATE TABLE verified_fact_versions (
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  version INTEGER NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  supporting_claims TEXT NOT NULL,
  conflicting_claims TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  valid_from TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'conflict', 'stale', 'quarantined')),
  recorded_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  PRIMARY KEY (entity_id, field, version)
);

CREATE INDEX verified_fact_versions_pit ON verified_fact_versions (entity_id, field, valid_from);

CREATE INDEX verified_fact_versions_run ON verified_fact_versions (run_id);

-- Source fields that are not in the field registry: logged and dropped, never guessed.
CREATE TABLE dropped_fields (
  source TEXT NOT NULL,
  source_field TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  occurrences INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, source_field, run_id)
);
