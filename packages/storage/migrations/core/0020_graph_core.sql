-- Task graph layer, G0 (brain/build-reports/graph-plan.md). Graphs are data: specs, compiled forms,
-- sandbox reports, runs and per-node runs. Large state values live in graph_state_values and only
-- references pass between Workflow steps. Down: packages/storage/migrations-down/0020_graph_core.sql.
CREATE TABLE graph_specs (
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  task_id TEXT NOT NULL,
  opportunity_id TEXT,
  hypothesis_id TEXT,
  spec TEXT NOT NULL,
  content_hash TEXT,
  registry_version TEXT,
  compiled TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('open', 'licensed')),
  worst_case_cost_gbp REAL,
  autonomy TEXT CHECK (autonomy IS NULL OR autonomy IN ('L0', 'L1', 'L2', 'L3')),
  shape_fingerprint TEXT,
  status TEXT NOT NULL CHECK (status IN ('drafting', 'probing', 'sandboxing', 'ready', 'approved', 'running', 'done', 'rejected', 'couldnt_plan', 'superseded')),
  attempt INTEGER NOT NULL DEFAULT 1,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (graph_id, version)
);
CREATE INDEX graph_specs_task ON graph_specs (task_id);

CREATE TABLE sandbox_reports (
  id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  scenario TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'probe')),
  as_of TEXT NOT NULL,
  pass INTEGER NOT NULL,
  report TEXT NOT NULL,
  sandbox_cost_gbp REAL NOT NULL,
  projected_live_cost_gbp REAL NOT NULL,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX sandbox_reports_graph ON sandbox_reports (graph_id, version);

CREATE TABLE graph_runs (
  run_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  instance_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'sandbox', 'probe')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'paused', 'done', 'failed', 'killed')),
  cost_so_far_gbp REAL NOT NULL DEFAULT 0,
  pause_reason TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome_id TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX graph_runs_graph ON graph_runs (graph_id, version);

CREATE TABLE graph_node_runs (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'done', 'failed', 'skipped', 'paused')),
  started_at TEXT,
  ended_at TEXT,
  cost_gbp REAL NOT NULL DEFAULT 0,
  output_ref TEXT,
  -- The model's output, recorded so a replay reuses it (reproducibility).
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

-- Archie's reasons when rejecting/editing/questioning a plan or idea (addition 1). Read by the planner
-- when revising and by its eval. Never part of the outcome ledger (rule 12).
CREATE TABLE decision_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('graph_plan', 'graph_node', 'idea')),
  subject_id TEXT NOT NULL,
  graph_id TEXT,
  graph_version INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('reject', 'edit', 'question')),
  reason TEXT NOT NULL,
  by TEXT NOT NULL,
  decision_id TEXT
);
CREATE INDEX decision_log_subject ON decision_log (subject, subject_id);

-- Graph tags on the existing records (the old runner leaves them NULL).
ALTER TABLE approvals ADD COLUMN graph_id TEXT;
ALTER TABLE approvals ADD COLUMN graph_version INTEGER;
ALTER TABLE approvals ADD COLUMN node_id TEXT;
ALTER TABLE approvals ADD COLUMN comment TEXT;
ALTER TABLE run_log ADD COLUMN graph_id TEXT;
ALTER TABLE run_log ADD COLUMN graph_version INTEGER;
ALTER TABLE run_log ADD COLUMN node_id TEXT;
