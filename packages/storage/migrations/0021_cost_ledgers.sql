-- Money ledgers (graph plan, G0). Append-only: rows are never updated or deleted (triggers enforce it).
-- cost_events is the single source of truth for spend; revenue_events holds settled money only
-- (refunds negative); pool_events holds Archie's top-ups and adjustments.
CREATE TABLE cost_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  run_id TEXT,
  graph_id TEXT,
  graph_version INTEGER,
  node_id TEXT,
  task_id TEXT,
  opportunity_id TEXT,
  revenue_path TEXT,
  shape_fingerprint TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('sandbox', 'probe', 'planner', 'live')),
  category TEXT NOT NULL CHECK (category IN ('model', 'tool', 'infra', 'third_party')),
  unit TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price_gbp REAL NOT NULL,
  amount_gbp REAL NOT NULL,
  price_table_version TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX cost_events_at ON cost_events (at);
CREATE INDEX cost_events_run ON cost_events (run_id);
CREATE INDEX cost_events_task ON cost_events (task_id);

CREATE TABLE revenue_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  run_id TEXT,
  task_id TEXT,
  opportunity_id TEXT,
  revenue_path TEXT NOT NULL,
  rail TEXT NOT NULL CHECK (rail IN ('stripe', 'x402')),
  reference TEXT NOT NULL,
  amount_gbp REAL NOT NULL,
  settled_at TEXT NOT NULL,
  test_mode INTEGER NOT NULL,
  UNIQUE (rail, reference, amount_gbp)
);
CREATE INDEX revenue_events_at ON revenue_events (settled_at);

CREATE TABLE pool_events (
  event_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topup', 'adjustment')),
  amount_gbp REAL NOT NULL,
  approval_id TEXT,
  by TEXT NOT NULL,
  note TEXT
);

CREATE TRIGGER cost_events_no_update BEFORE UPDATE ON cost_events
BEGIN
  SELECT RAISE(ABORT, 'cost_events is append-only');
END;
CREATE TRIGGER cost_events_no_delete BEFORE DELETE ON cost_events
BEGIN
  SELECT RAISE(ABORT, 'cost_events is append-only');
END;
CREATE TRIGGER revenue_events_no_update BEFORE UPDATE ON revenue_events
BEGIN
  SELECT RAISE(ABORT, 'revenue_events is append-only');
END;
CREATE TRIGGER revenue_events_no_delete BEFORE DELETE ON revenue_events
BEGIN
  SELECT RAISE(ABORT, 'revenue_events is append-only');
END;
CREATE TRIGGER pool_events_no_update BEFORE UPDATE ON pool_events
BEGIN
  SELECT RAISE(ABORT, 'pool_events is append-only');
END;
CREATE TRIGGER pool_events_no_delete BEFORE DELETE ON pool_events
BEGIN
  SELECT RAISE(ABORT, 'pool_events is append-only');
END;
