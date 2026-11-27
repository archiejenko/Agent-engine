-- v4 Phase 1 (PLAN.md §2.2): one canonical business ID across markets, external IDs, contacts with
-- provenance, one signals table, the source registry and its fetch cache, and shared briefs.

-- business_id is deterministic: gb-ch:<company number> for UK companies, us-<state>:<entity id> for US
-- registry entities, bz:<id> only when no registry ID exists. `entities` stays the Companies House record;
-- its entity_id is the uk_ch external ID.
CREATE TABLE businesses (
  business_id TEXT PRIMARY KEY CHECK (business_id GLOB 'gb-ch:*' OR business_id GLOB 'us-[a-z][a-z]:*' OR business_id GLOB 'bz:*'),
  name TEXT NOT NULL,
  name_normalised TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  status TEXT,
  company_type TEXT,
  industry_code TEXT,
  size_band TEXT,
  primary_domain TEXT,
  merged_into TEXT REFERENCES businesses (business_id),
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX businesses_market ON businesses (market, region);
CREATE INDEX businesses_name ON businesses (name_normalised);

CREATE TABLE external_ids (
  business_id TEXT NOT NULL REFERENCES businesses (business_id),
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  source_id TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (scheme, value)
);
CREATE INDEX external_ids_business ON external_ids (business_id);

CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('bulk', 'api', 'scrape', 'vendor')),
  tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 5),
  lane TEXT NOT NULL CHECK (lane IN ('open', 'paid_own_use', 'licensed')),
  retention TEXT NOT NULL CHECK (retention IN ('full', 'id_only')),
  cost_model TEXT NOT NULL,
  freshness_target_h INTEGER NOT NULL CHECK (freshness_target_h > 0),
  reliability REAL CHECK (reliability BETWEEN 0 AND 1),
  health TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok', 'degraded', 'paused', 'schema_drift')),
  schema_hash TEXT,
  connected INTEGER NOT NULL DEFAULT 0,
  connected_at TEXT,
  connected_for TEXT,
  terms_url TEXT,
  terms_checked_at TEXT,
  used_by TEXT NOT NULL DEFAULT '[]',
  config_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The fetch cache. Bodies go through the storage body helper (inline if small, else R2): body, body_key,
-- body_size, body_sha256. id_only sources never store a body: only their IDs.
CREATE TABLE source_fetches (
  fetch_key TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources (source_id),
  request TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  body TEXT,
  body_key TEXT,
  body_size INTEGER,
  body_sha256 TEXT,
  ids TEXT NOT NULL DEFAULT '[]',
  cost_gbp REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  schema_hash TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX source_fetches_source ON source_fetches (source_id, fetched_at);

CREATE TABLE contacts (
  contact_id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses (business_id),
  kind TEXT NOT NULL CHECK (kind IN ('role_address', 'named_person')),
  email TEXT,
  email_verified TEXT NOT NULL DEFAULT 'unknown' CHECK (email_verified IN ('valid', 'risky', 'invalid', 'unknown')),
  verifier_source_id TEXT,
  name TEXT,
  title TEXT,
  recipient_type TEXT NOT NULL DEFAULT 'unknown' CHECK (recipient_type IN ('corporate', 'sole_trader', 'partnership', 'unknown')),
  source_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'paid_own_use', 'licensed')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  fetched_at TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  UNIQUE (business_id, email)
);
CREATE INDEX contacts_business ON contacts (business_id);

-- One signals table. kind 'engine' = a deterministic signal over verified facts (was signal_values);
-- kind 'scout' = a research signal from fetched content (was scout_signals; always untrusted).
CREATE TABLE signals (
  signal_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('engine', 'scout')),
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  business_id TEXT,
  problem_id TEXT,
  value TEXT,
  fact_ids TEXT NOT NULL DEFAULT '[]',
  source_id TEXT,
  untrusted INTEGER NOT NULL DEFAULT 0,
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  observed_at TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'paid_own_use', 'licensed')),
  run_id TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  CHECK (kind = 'engine' OR untrusted = 1)
);
CREATE INDEX signals_business ON signals (business_id, definition_id);
CREATE INDEX signals_market ON signals (market, region, valid_from);

CREATE TABLE briefs (
  business_id TEXT NOT NULL REFERENCES businesses (business_id),
  brief_version INTEGER NOT NULL,
  fact_ids TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  body_key TEXT,
  body_size INTEGER,
  body_sha256 TEXT,
  model TEXT NOT NULL,
  cost_gbp REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (business_id, brief_version)
);
