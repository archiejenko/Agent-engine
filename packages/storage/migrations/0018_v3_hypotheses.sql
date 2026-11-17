-- Seeded ideas backlog (brain/ideas/seed-500.csv) as hypotheses. Every score here is an ESTIMATE
-- (rule 23): never an outcome, never in the outcome ledger, never read by scoring or learning code.
-- score and matrix are recomputed in code from the six scores; the file's values are not trusted.
CREATE TABLE hypotheses (
  id TEXT PRIMARY KEY CHECK (id GLOB 'I[0-9][0-9][0-9]*'),
  rank INTEGER NOT NULL,
  idea TEXT NOT NULL,
  category TEXT NOT NULL,
  taxonomy_node TEXT,
  buyer TEXT NOT NULL,
  revenue_model TEXT NOT NULL,
  why_now TEXT NOT NULL,
  batch TEXT NOT NULL,
  autonomy INTEGER NOT NULL CHECK (autonomy BETWEEN 1 AND 5),
  speed_to_cash INTEGER NOT NULL CHECK (speed_to_cash BETWEEN 1 AND 5),
  demand INTEGER NOT NULL CHECK (demand BETWEEN 1 AND 5),
  margin INTEGER NOT NULL CHECK (margin BETWEEN 1 AND 5),
  ease_of_build INTEGER NOT NULL CHECK (ease_of_build BETWEEN 1 AND 5),
  low_risk INTEGER NOT NULL CHECK (low_risk BETWEEN 1 AND 5),
  score INTEGER NOT NULL,
  matrix TEXT NOT NULL CHECK (matrix IN ('Do first', 'Big bet', 'Quick win', 'Park')),
  score_source TEXT NOT NULL DEFAULT 'estimate' CHECK (score_source = 'estimate'),
  file_status TEXT NOT NULL CHECK (file_status IN ('New', 'Built')),
  stage TEXT NOT NULL,
  -- Set when Archie or an agent changes the stage; a re-import then leaves the stage alone.
  stage_changed_by TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('Pass', 'Fail', 'Question')),
  decision_by TEXT,
  decision_at TEXT,
  -- Fingerprint (idea text + six scores) when it failed: an unchanged failed idea can't be re-raised.
  failed_fingerprint TEXT,
  comments TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX hypotheses_rank ON hypotheses (rank);

-- Every score value a hypothesis has had: who set it, when and why (append-only).
CREATE TABLE hypothesis_score_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses (id),
  field TEXT NOT NULL CHECK (field IN ('autonomy', 'speed_to_cash', 'demand', 'margin', 'ease_of_build', 'low_risk')),
  old_value INTEGER,
  new_value INTEGER NOT NULL CHECK (new_value BETWEEN 1 AND 5),
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX hypothesis_score_history_h ON hypothesis_score_history (hypothesis_id, id);

CREATE TABLE hypothesis_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  rows INTEGER NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  unchanged INTEGER NOT NULL,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
