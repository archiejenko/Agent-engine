-- Data layer plan, step 2: the single database becomes three (core, facts, telemetry).
-- Run AFTER the facts and telemetry baselines exist. Locally the rows of every moved table are copied
-- into their new database first (packages/storage/src/split-local.ts); on Cloudflare the tables are empty.
-- Graph run state moved to the RunState Durable Objects (step 1); the workflow step and event tables are
-- local-only now (local-runtime.ts).

-- opportunities.run_id referenced runs, which moves to facts: rebuild without that foreign key.
CREATE TABLE _opportunities_copy AS SELECT * FROM opportunities;
DROP TABLE opportunities;
CREATE TABLE opportunities (
  opportunity_id TEXT PRIMARY KEY,
  module TEXT NOT NULL,
  module_version INTEGER NOT NULL,
  note_hash TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  as_of TEXT NOT NULL,
  score REAL NOT NULL,
  expected_value_gbp REAL NOT NULL,
  confidence REAL NOT NULL,
  trace TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('open', 'licensed')),
  explore INTEGER NOT NULL CHECK (explore IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'actioned')),
  rank INTEGER NOT NULL,
  rationale TEXT,
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
INSERT INTO opportunities SELECT * FROM _opportunities_copy;
DROP TABLE _opportunities_copy;
CREATE INDEX opportunities_queue ON opportunities (status, module, rank);
CREATE INDEX opportunities_entity ON opportunities (entity_id);

-- Tables that moved out (children before parents).
DROP TABLE graph_state_values;
DROP TABLE graph_node_runs;
DROP TABLE workflow_events;
DROP TABLE runtime_status;
DROP TABLE trigger_stats;
DROP TABLE dead_letters;
DROP TABLE workflow_steps;
DROP TABLE blind_checks;
DROP TABLE weight_suggestions;
DROP TABLE backtests;
DROP TABLE source_pauses;
DROP TABLE drift_metrics;
DROP TABLE golden_entities;
DROP TABLE quarantined_matches;
DROP TABLE run_log;
DROP TABLE module_runs;
DROP TABLE signal_values;
DROP TABLE verification_requests;
DROP TABLE ingest_progress;
DROP TABLE universe_members;
DROP TABLE entities;
DROP TABLE claim_observations;
DROP TABLE dropped_fields;
DROP TABLE verified_fact_versions;
DROP TABLE verified_facts;
DROP TABLE claim_rejections;
DROP TABLE claim_supersessions;
DROP TABLE claims;
DROP TABLE runs;
