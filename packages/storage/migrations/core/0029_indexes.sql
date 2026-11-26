-- Data layer plan, step 6 (index audit, core database): indexes for the scans that grow, found by
-- EXPLAIN QUERY PLAN over every query (docs/gates/data-layer-explain.md), and WITHOUT ROWID where the
-- key is composite and rows are small. Tables are rebuilt by copy, drop, create, copy back: rows kept.
-- cost_events_at goes: cost_events_spend (at, mode, playbook) starts with the same column.
-- tasks.entity_ref (virtual) replaces the source_ref LIKE '%:entity:N' scan with an index lookup.

DROP INDEX cost_events_at;
ALTER TABLE tasks ADD COLUMN entity_ref TEXT GENERATED ALWAYS AS (CASE WHEN instr(source_ref, ':entity:') > 0 THEN substr(source_ref, instr(source_ref, ':entity:') + 8) END) VIRTUAL;
CREATE INDEX tasks_entity ON tasks (entity_ref, created_at);
CREATE INDEX tasks_created ON tasks (created_at);
CREATE INDEX outcomes_time ON outcomes (observed_at);
CREATE INDEX outcomes_opportunity ON outcomes (opportunity_id, observed_at);
CREATE INDEX outbox_created ON outbox (created_at);
CREATE INDEX outbox_entity ON outbox (entity_id, created_at);
CREATE INDEX decisions_decided ON decisions (decided_at);
CREATE INDEX review_sessions_decided ON review_sessions (decided_at);
CREATE INDEX site_claims_updated ON site_claims (updated_at);
CREATE INDEX alerts_open ON alerts (acknowledged_at, id);
CREATE INDEX decision_log_graph ON decision_log (graph_id, at);
CREATE INDEX decision_log_at ON decision_log (at);
CREATE INDEX experiments_market ON experiments (market_key, started_at);
CREATE INDEX experiments_status ON experiments (status);
CREATE INDEX playbook_examples_step ON playbook_examples (playbook, step_id, id);
CREATE INDEX owner_approvals_created ON owner_approvals (created_at);
CREATE INDEX idea_cards_hypothesis ON idea_cards (hypothesis_id, created_at);
CREATE INDEX letters_entity ON letters (entity_id, created_at);
CREATE INDEX scout_signals_observed ON scout_signals (observed_at);
CREATE INDEX payments_ledger_rail ON payments_ledger (rail, created_at);
-- Home's holdout arm counts read only this index (partial and covering).
CREATE INDEX outcomes_arms ON outcomes (arm, event, entity_id) WHERE cohort_id IS NOT NULL AND arm IS NOT NULL AND synthetic = 0;

-- cohort_members: WITHOUT ROWID
CREATE TABLE _cohort_members_copy AS SELECT * FROM cohort_members;
DROP TABLE cohort_members;
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
) WITHOUT ROWID;
INSERT INTO cohort_members (cohort_id, entity_id, arm, channel, p_paid, ev_gbp, task_id, status, reason) SELECT cohort_id, entity_id, arm, channel, p_paid, ev_gbp, task_id, status, reason FROM _cohort_members_copy;
DROP TABLE _cohort_members_copy;
CREATE INDEX cohort_members_task ON cohort_members (task_id);
-- followups: WITHOUT ROWID
CREATE TABLE _followups_copy AS SELECT * FROM followups;
DROP TABLE followups;
CREATE TABLE followups (
  thread_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  opportunity_id TEXT,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'cancelled')),
  reason TEXT,
  PRIMARY KEY (thread_id, attempt)
) WITHOUT ROWID;
INSERT INTO followups (thread_id, attempt, entity_id, opportunity_id, due_at, status, reason) SELECT thread_id, attempt, entity_id, opportunity_id, due_at, status, reason FROM _followups_copy;
DROP TABLE _followups_copy;
CREATE INDEX followups_due ON followups (status, due_at);
