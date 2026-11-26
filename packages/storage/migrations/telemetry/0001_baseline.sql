-- The telemetry database (agent-engine-telemetry), data layer plan step 2: the run log and runtime
-- health. Same schema as before, except run_log.task_id no longer REFERENCES tasks (tasks are in core).

CREATE TABLE run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
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
