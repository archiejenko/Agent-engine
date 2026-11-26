-- Data layer plan, step 6 (index audit, facts database): indexes for the scans that grow, found by
-- EXPLAIN QUERY PLAN over every query (docs/gates/data-layer-explain.md), and WITHOUT ROWID where the
-- key is composite and rows are small. Tables are rebuilt by copy, drop, create, copy back: rows kept.

CREATE INDEX runs_status ON runs (status);
CREATE INDEX module_runs_module ON module_runs (module, created_at);
CREATE INDEX claim_rejections_time ON claim_rejections (rejected_at);
CREATE INDEX quarantined_matches_open ON quarantined_matches (resolved_at, created_at);

-- claim_observations: WITHOUT ROWID (its index on the key's first column goes: the key covers it)
CREATE TABLE _claim_observations_copy AS SELECT * FROM claim_observations;
DROP TABLE claim_observations;
CREATE TABLE claim_observations (
  claim_id TEXT NOT NULL REFERENCES claims (claim_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, run_id)
) WITHOUT ROWID;
INSERT INTO claim_observations (claim_id, run_id, fetched_at) SELECT claim_id, run_id, fetched_at FROM _claim_observations_copy;
DROP TABLE _claim_observations_copy;
-- signal_values: WITHOUT ROWID
CREATE TABLE _signal_values_copy AS SELECT * FROM signal_values;
DROP TABLE signal_values;
CREATE TABLE signal_values (
  signal_id TEXT NOT NULL,
  signal_version INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  value REAL,
  fact_ids TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  PRIMARY KEY (signal_id, signal_version, entity_id, as_of)
) WITHOUT ROWID;
INSERT INTO signal_values (signal_id, signal_version, entity_id, as_of, value, fact_ids, run_id) SELECT signal_id, signal_version, entity_id, as_of, value, fact_ids, run_id FROM _signal_values_copy;
DROP TABLE _signal_values_copy;
-- universe_members: WITHOUT ROWID
CREATE TABLE _universe_members_copy AS SELECT * FROM universe_members;
DROP TABLE universe_members;
CREATE TABLE universe_members (
  universe TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  reason TEXT NOT NULL,
  staff_flag TEXT NOT NULL CHECK (staff_flag IN ('known', 'staff_unknown', 'not_checked')),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (universe, entity_id)
) WITHOUT ROWID;
INSERT INTO universe_members (universe, entity_id, included, reason, staff_flag, run_id, decided_at) SELECT universe, entity_id, included, reason, staff_flag, run_id, decided_at FROM _universe_members_copy;
DROP TABLE _universe_members_copy;
CREATE INDEX universe_members_included ON universe_members (universe, included);
-- drift_metrics: WITHOUT ROWID
CREATE TABLE _drift_metrics_copy AS SELECT * FROM drift_metrics;
DROP TABLE drift_metrics;
CREATE TABLE drift_metrics (
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  volume INTEGER NOT NULL,
  null_rate REAL NOT NULL,
  mean REAL,
  top_share REAL,
  match_rate REAL NOT NULL,
  PRIMARY KEY (day, source, field)
) WITHOUT ROWID;
INSERT INTO drift_metrics (day, source, field, volume, null_rate, mean, top_share, match_rate) SELECT day, source, field, volume, null_rate, mean, top_share, match_rate FROM _drift_metrics_copy;
DROP TABLE _drift_metrics_copy;
-- ingest_progress: WITHOUT ROWID
CREATE TABLE _ingest_progress_copy AS SELECT * FROM ingest_progress;
DROP TABLE ingest_progress;
CREATE TABLE ingest_progress (
  job TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job, entity_id, step)
) WITHOUT ROWID;
INSERT INTO ingest_progress (job, entity_id, step, status, attempts, last_error, updated_at) SELECT job, entity_id, step, status, attempts, last_error, updated_at FROM _ingest_progress_copy;
DROP TABLE _ingest_progress_copy;
CREATE INDEX ingest_progress_status ON ingest_progress (job, status);
-- dropped_fields: WITHOUT ROWID
CREATE TABLE _dropped_fields_copy AS SELECT * FROM dropped_fields;
DROP TABLE dropped_fields;
CREATE TABLE dropped_fields (
  source TEXT NOT NULL,
  source_field TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  occurrences INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, source_field, run_id)
) WITHOUT ROWID;
INSERT INTO dropped_fields (source, source_field, run_id, occurrences, first_seen_at) SELECT source, source_field, run_id, occurrences, first_seen_at FROM _dropped_fields_copy;
DROP TABLE _dropped_fields_copy;
-- source_pauses: WITHOUT ROWID
CREATE TABLE _source_pauses_copy AS SELECT * FROM source_pauses;
DROP TABLE source_pauses;
CREATE TABLE source_pauses (
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  PRIMARY KEY (source, field, paused_at)
) WITHOUT ROWID;
INSERT INTO source_pauses (source, field, reason, paused_at, resumed_at) SELECT source, field, reason, paused_at, resumed_at FROM _source_pauses_copy;
DROP TABLE _source_pauses_copy;
