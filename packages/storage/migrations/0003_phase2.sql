-- 0003_phase2: opportunity engine + agent infrastructure.

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

CREATE INDEX opportunities_queue ON opportunities (status, module, rank);

CREATE INDEX opportunities_entity ON opportunities (entity_id);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  playbook TEXT NOT NULL,
  playbook_version INTEGER NOT NULL,
  revenue_path TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  autonomy TEXT NOT NULL CHECK (autonomy IN ('L0', 'L1', 'L2', 'L3')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled')),
  budget_gbp REAL NOT NULL,
  revenue_gbp REAL NOT NULL DEFAULT 0,
  cost_gbp REAL NOT NULL DEFAULT 0,
  priority TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_status ON tasks (status, priority, created_at);

CREATE INDEX tasks_playbook ON tasks (playbook, created_at);

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
);

CREATE INDEX run_log_task ON run_log (task_id, id);

CREATE INDEX run_log_time ON run_log (timestamp);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  step_id TEXT NOT NULL,
  item_shown TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'edit', 'reject')),
  edited_text TEXT,
  decided_at TEXT NOT NULL
);

CREATE INDEX approvals_task ON approvals (task_id);

-- Archie's edits become examples for the playbook's writer.
CREATE TABLE playbook_examples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playbook TEXT NOT NULL,
  step_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  original TEXT NOT NULL,
  edited TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Kill switches, spend caps, autonomy levels, queue pause. JSON values.
CREATE TABLE controls (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Things Archie must hear about (caps hit, kill switches, drift, breaches). Delivery is a port.
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

-- Records from other sources we couldn't anchor confidently to a company.
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
