-- Reverses 0026_split: the moved tables come back exactly as they were (empty), and opportunities gets
-- its foreign key to runs again. Local and test use only.

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rolled_back')),
  config_versions TEXT NOT NULL DEFAULT '{}'
, partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1)));

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

CREATE TABLE claim_rejections (
  claim_id TEXT PRIMARY KEY REFERENCES claims (claim_id),
  rule TEXT NOT NULL,
  detail TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

CREATE TABLE verified_facts (
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  supporting_claims TEXT NOT NULL,
  conflicting_claims TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  valid_from TEXT NOT NULL,
  first_observed_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'conflict', 'stale', 'quarantined')),
  version INTEGER NOT NULL,
  PRIMARY KEY (entity_id, field)
);

CREATE INDEX verified_facts_field ON verified_facts (field, status);

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
  first_observed_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified', 'conflict', 'stale', 'quarantined')),
  recorded_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  PRIMARY KEY (entity_id, field, version)
);

CREATE INDEX verified_fact_versions_pit ON verified_fact_versions (entity_id, field, valid_from);

CREATE INDEX verified_fact_versions_run ON verified_fact_versions (run_id);

CREATE TABLE dropped_fields (
  source TEXT NOT NULL,
  source_field TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  occurrences INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  PRIMARY KEY (source, source_field, run_id)
);

CREATE TABLE claim_observations (
  claim_id TEXT NOT NULL REFERENCES claims (claim_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, run_id)
);

CREATE INDEX claim_observations_claim ON claim_observations (claim_id, fetched_at);

CREATE TABLE entities (
  entity_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalised TEXT NOT NULL,
  postcode TEXT,
  lad_code TEXT,
  company_status TEXT,
  accounts_category TEXT,
  sic_codes TEXT NOT NULL DEFAULT '[]',
  charges_count INTEGER,
  incorporation_date TEXT,
  source_run_id TEXT NOT NULL REFERENCES runs (run_id),
  updated_at TEXT NOT NULL
);

CREATE INDEX entities_name ON entities (name_normalised);

CREATE INDEX entities_postcode ON entities (postcode);

CREATE TABLE universe_members (
  universe TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES entities (entity_id),
  included INTEGER NOT NULL CHECK (included IN (0, 1)),
  reason TEXT NOT NULL,
  staff_flag TEXT NOT NULL CHECK (staff_flag IN ('known', 'staff_unknown', 'not_checked')),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  decided_at TEXT NOT NULL,
  PRIMARY KEY (universe, entity_id)
);

CREATE INDEX universe_members_included ON universe_members (universe, included);

CREATE TABLE ingest_progress (
  job TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job, entity_id, step)
);

CREATE INDEX ingest_progress_status ON ingest_progress (job, status);

CREATE TABLE verification_requests (
  request_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL,
  deadline TEXT,
  requested_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX verification_requests_open ON verification_requests (processed_at, deadline);

CREATE TABLE signal_values (
  signal_id TEXT NOT NULL,
  signal_version INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  value REAL,
  fact_ids TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  PRIMARY KEY (signal_id, signal_version, entity_id, as_of)
);

CREATE TABLE module_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  module TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  note_hash TEXT NOT NULL,
  as_of TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('reconstructed', 'strict')),
  candidates INTEGER NOT NULL,
  above_threshold INTEGER NOT NULL,
  explore INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  step_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model TEXT,
  tool_calls TEXT NOT NULL,
  output TEXT NOT NULL,
  check_result TEXT,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_gbp REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  timestamp TEXT NOT NULL
, graph_id TEXT, graph_version INTEGER, node_id TEXT);

CREATE INDEX run_log_task ON run_log (task_id, id);

CREATE INDEX run_log_time ON run_log (timestamp);

CREATE TABLE quarantined_matches (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  raw_ref TEXT NOT NULL,
  record TEXT NOT NULL,
  candidates TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_entity_id TEXT,
  resolved_at TEXT
);

CREATE TABLE golden_entities (
  entity_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('sample', 'conflict')),
  added_at TEXT NOT NULL
);

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
);

CREATE TABLE source_pauses (
  source TEXT NOT NULL,
  field TEXT NOT NULL,
  reason TEXT NOT NULL,
  paused_at TEXT NOT NULL,
  resumed_at TEXT,
  PRIMARY KEY (source, field, paused_at)
);

CREATE TABLE backtests (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  note_hash TEXT NOT NULL,
  as_of TEXT NOT NULL,
  mode TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  precision_at_20 REAL NOT NULL,
  base_rate REAL NOT NULL,
  lift REAL NOT NULL,
  revenue_lift REAL,
  calibration TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX backtests_module ON backtests (module, created_at);

CREATE TABLE weight_suggestions (
  id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  current_weights TEXT NOT NULL,
  suggested_weights TEXT NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE blind_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  source TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  fresh_value TEXT,
  agree INTEGER NOT NULL CHECK (agree IN (0, 1)),
  checked_at TEXT NOT NULL
);

CREATE INDEX blind_checks_pair ON blind_checks (source, field, checked_at);

CREATE TABLE workflow_steps (
  instance_id TEXT NOT NULL REFERENCES workflow_instances (id),
  name TEXT NOT NULL,
  output TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, name)
);

CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT,
  received_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE trigger_stats (
  day TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  acted INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule_id)
);

CREATE TABLE runtime_status (
  name TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  detail TEXT
);

CREATE TABLE workflow_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX workflow_events_waiting ON workflow_events (instance_id, type, consumed_at);

CREATE TABLE graph_node_runs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'paused')),
  started_at TEXT,
  ended_at TEXT,
  cost_gbp REAL NOT NULL DEFAULT 0,
  output_ref TEXT,
  recorded_model_output TEXT,
  check_results TEXT,
  error TEXT,
  PRIMARY KEY (run_id, node_id, iteration)
);

CREATE TABLE graph_state_values (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  value TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 0,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  written_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, key, iteration)
);

CREATE TABLE _opportunities_copy AS SELECT * FROM opportunities;
DROP TABLE opportunities;
CREATE TABLE opportunities (
  opportunity_id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  note_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  score REAL NOT NULL,
  expected_value_gbp REAL NOT NULL,
  confidence REAL NOT NULL,
  trace TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  explore INTEGER NOT NULL CHECK (explore IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'actioned')),
  rank INTEGER NOT NULL,
  rationale TEXT,
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  created_at TEXT NOT NULL,
  decided_at TEXT
);
INSERT INTO opportunities SELECT * FROM _opportunities_copy;
DROP TABLE _opportunities_copy;
CREATE INDEX opportunities_queue ON opportunities (status, module, rank);
CREATE INDEX opportunities_entity ON opportunities (entity_id);
