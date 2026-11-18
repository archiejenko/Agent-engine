-- v3 Phase 6 (with v2 Phase 7): scout signals, versioned idea cards, the card thread, the Board, and
-- experiments. A card revision is a new row (card_id, version); nothing is edited in place except status.

-- Signals: the only output of a scout. Always untrusted. Schema-checked before they are stored.
CREATE TABLE scout_signals (
  signal_id TEXT PRIMARY KEY,
  field TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  entity_id TEXT,
  signal_type TEXT NOT NULL,
  value TEXT NOT NULL,
  taxonomy_node TEXT NOT NULL,
  market_key TEXT NOT NULL,
  market TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  untrusted INTEGER NOT NULL DEFAULT 1 CHECK (untrusted = 1),
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX scout_signals_market ON scout_signals (market_key, observed_at);

CREATE TABLE idea_cards (
  card_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hypothesis_id TEXT,
  market_key TEXT NOT NULL,
  card TEXT NOT NULL,
  status TEXT NOT NULL,
  status_reason TEXT,
  rank_value REAL NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (card_id, version)
);
CREATE INDEX idea_cards_status ON idea_cards (status, rank_value);
CREATE INDEX idea_cards_market ON idea_cards (market_key);

-- Questions, answers, comments and revisions on a card (append-only).
CREATE TABLE idea_thread (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'comment', 'revision')),
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idea_thread_card ON idea_thread (card_id, id);
CREATE TRIGGER idea_thread_no_update BEFORE UPDATE ON idea_thread
BEGIN
  SELECT RAISE(ABORT, 'idea_thread is append-only');
END;
CREATE TRIGGER idea_thread_no_delete BEFORE DELETE ON idea_thread
BEGIN
  SELECT RAISE(ABORT, 'idea_thread is append-only');
END;

-- The Board: one tile per market, in one column. Agents move tiles; Archie pins or kills them.
CREATE TABLE board_tiles (
  market_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  field TEXT NOT NULL,
  col TEXT NOT NULL CHECK (col IN ('scanning', 'researching', 'proposed', 'testing', 'live', 'killed')),
  pinned INTEGER NOT NULL DEFAULT 0,
  synthetic INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE board_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_key TEXT NOT NULL,
  from_col TEXT,
  to_col TEXT NOT NULL,
  by TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX board_moves_market ON board_moves (market_key, id);

-- An approved card's test: a budget envelope inside the explore share, checked daily against its kill
-- criteria; it kills itself when one trips and writes a post-mortem to the Vault.
CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  hypothesis_id TEXT,
  market_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'killed', 'succeeded', 'ended')),
  budget_gbp REAL NOT NULL,
  spent_gbp REAL NOT NULL DEFAULT 0,
  instance_id TEXT,
  approval_id TEXT,
  kill_reason TEXT,
  postmortem_path TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX experiments_card ON experiments (card_id);
