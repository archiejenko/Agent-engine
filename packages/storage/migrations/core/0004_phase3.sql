-- 0004_phase3: measurement and outcomes.

-- Companies Archie has hand-verified (or resolved a conflict on). Their human claims are the truth set.
CREATE TABLE golden_entities (
  entity_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('sample', 'conflict')),
  added_at TEXT NOT NULL
);

-- What happened after we acted. opportunity_id may be null for entity-level events (e.g. replies
-- matched to a company); backtests join outcomes to companies and dates.
CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT,
  entity_id TEXT NOT NULL,
  module TEXT,
  event TEXT NOT NULL,
  value_bool INTEGER,
  value_gbp REAL,
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('human', 'system', 'verified_fact')),
  created_at TEXT NOT NULL
);

CREATE INDEX outcomes_entity ON outcomes (entity_id, observed_at);

CREATE INDEX outcomes_opportunity ON outcomes (opportunity_id);

-- Daily drift metrics per source + field.
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

-- A paused source+field can't make facts verified (drift breach). Resumed by Archie.
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

-- Suggested weight changes written into framework notes; Archie accepts or rejects.
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
