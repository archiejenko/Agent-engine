-- 0002_phase1: verification engine tables.

-- effective_from mixed two meanings; it is the earliest time a supporting source asserted the value.
ALTER TABLE verified_facts RENAME COLUMN effective_from TO first_observed_at;

ALTER TABLE verified_fact_versions RENAME COLUMN effective_from TO first_observed_at;

-- Every time a run (re)fetches a claim we already hold, we record an observation instead of a
-- duplicate claim. last_verified_at comes from here.
CREATE TABLE claim_observations (
  claim_id TEXT NOT NULL REFERENCES claims (claim_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, run_id)
);

CREATE INDEX claim_observations_claim ON claim_observations (claim_id, fetched_at);

-- Anchor registry: every UK company we know of, keyed by Companies House number.
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

-- Universe membership with the reason for every inclusion/exclusion decision.
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

-- Resumable ingestion: one row per entity + step.
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

-- requestVerification(): the opportunity engine / playbooks ask for fresh facts.
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
