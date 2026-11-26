-- v2 Phase 1: the outcome ledger, holdout cohorts, demo visits and review minutes.

-- The existing outcomes table becomes the ledger. SQLite can't change a CHECK constraint, so the table is
-- rebuilt and its rows copied (they keep their events; synthetic = 0, dry_run = 0).
CREATE TABLE outcomes_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT,
  entity_id TEXT NOT NULL,
  module TEXT,
  event TEXT NOT NULL,
  value_bool INTEGER,
  value_gbp REAL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'system', 'verified_fact', 'stripe', 'demo', 'inbox', 'outbox', 'letters', 'simulator')),
  created_at TEXT NOT NULL,
  task_id TEXT,
  playbook TEXT,
  playbook_version INTEGER,
  experiment_id TEXT,
  hypothesis_id TEXT,
  cohort_id TEXT,
  arm TEXT CHECK (arm IS NULL OR arm IN ('ranked', 'holdout')),
  value_kind TEXT NOT NULL DEFAULT 'actual' CHECK (value_kind IN ('actual', 'estimate')),
  assumption TEXT,
  ms_on_page INTEGER,
  synthetic INTEGER NOT NULL DEFAULT 0 CHECK (synthetic IN (0, 1)),
  dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
  dedupe_key TEXT UNIQUE
);

INSERT INTO outcomes_v2 (id, opportunity_id, entity_id, module, event, value_bool, value_gbp, observed_at, source, created_at)
SELECT id, opportunity_id, entity_id, module, event, value_bool, value_gbp, observed_at, source, created_at FROM outcomes;

DROP TABLE outcomes;
ALTER TABLE outcomes_v2 RENAME TO outcomes;

CREATE INDEX outcomes_entity ON outcomes (entity_id, observed_at);
CREATE INDEX outcomes_event ON outcomes (event, observed_at);
CREATE INDEX outcomes_task ON outcomes (task_id);
CREATE INDEX outcomes_learning ON outcomes (playbook, event, synthetic, dry_run, created_at);
CREATE INDEX outcomes_cohort ON outcomes (cohort_id, arm, event);

-- Rows the simulator writes into any database are marked, so learning can never read them.
ALTER TABLE tasks ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE letters ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments_ledger ADD COLUMN synthetic INTEGER NOT NULL DEFAULT 0;

-- Holdout control: each outreach cohort (one intake) has ranked members and a random, unranked holdout
-- drawn with a recorded seed. Members that were skipped keep their reason.
CREATE TABLE outreach_cohorts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  seed TEXT NOT NULL,
  holdout_share REAL NOT NULL,
  ranked INTEGER NOT NULL,
  holdout INTEGER NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cohort_members (
  cohort_id TEXT NOT NULL REFERENCES outreach_cohorts (id),
  entity_id TEXT NOT NULL,
  arm TEXT NOT NULL CHECK (arm IN ('ranked', 'holdout')),
  channel TEXT CHECK (channel IS NULL OR channel IN ('email', 'letter')),
  p_paid REAL,
  ev_gbp REAL,
  task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('assigned', 'skipped')),
  reason TEXT,
  PRIMARY KEY (cohort_id, entity_id)
);

CREATE INDEX cohort_members_task ON cohort_members (task_id);

-- Demo-page visits: no IP, no user agent, no cookies. Source = qr (scanned) or link (typed).
CREATE TABLE demo_visits (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  task_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('qr', 'link')),
  visited_at TEXT NOT NULL,
  ms_on_page INTEGER,
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX demo_visits_slug ON demo_visits (slug, visited_at);

-- Archie's time per review item (opened → decided, counting only time the page was visible).
CREATE TABLE review_sessions (
  id TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  task_ids TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  active_ms INTEGER NOT NULL CHECK (active_ms >= 0),
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX review_sessions_item ON review_sessions (item_type, item_id);
