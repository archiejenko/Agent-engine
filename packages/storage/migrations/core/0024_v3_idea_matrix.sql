-- Archie's ranked idea matrix (brain/ideas/ranked-ideas.csv, 2026-11-24): a second backlog batch with
-- its OWN four scores (fit, speed to £, demand, solo-build; 1-5 each, max 20). Kept apart from the six
-- seeded scores so nothing is invented to fit one scheme into the other. Every score is an ESTIMATE
-- (rule 23): never an outcome, never in the outcome ledger, never read by scoring or learning code.
-- score and rank are recomputed in code; the file's own values are only compared.
CREATE TABLE idea_matrix (
  id TEXT PRIMARY KEY CHECK (id GLOB 'R[0-9]*'),
  list_no INTEGER NOT NULL UNIQUE,
  rank INTEGER NOT NULL,
  idea TEXT NOT NULL,
  build_angle TEXT NOT NULL,
  fit INTEGER NOT NULL CHECK (fit BETWEEN 1 AND 5),
  speed_to_cash INTEGER NOT NULL CHECK (speed_to_cash BETWEEN 1 AND 5),
  demand INTEGER NOT NULL CHECK (demand BETWEEN 1 AND 5),
  solo_build INTEGER NOT NULL CHECK (solo_build BETWEEN 1 AND 5),
  score INTEGER NOT NULL,
  score_source TEXT NOT NULL DEFAULT 'estimate' CHECK (score_source = 'estimate'),
  decision TEXT CHECK (decision IS NULL OR decision IN ('Pass', 'Fail', 'Question')),
  decision_by TEXT,
  decision_at TEXT,
  comments TEXT,
  source TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idea_matrix_rank ON idea_matrix (rank);
