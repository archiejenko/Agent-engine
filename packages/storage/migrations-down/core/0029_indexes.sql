-- Reverses 0029_indexes.sql (core). Local and test use only.

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
);
INSERT INTO followups (thread_id, attempt, entity_id, opportunity_id, due_at, status, reason) SELECT thread_id, attempt, entity_id, opportunity_id, due_at, status, reason FROM _followups_copy;
DROP TABLE _followups_copy;
CREATE INDEX followups_due ON followups (status, due_at);
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
);
INSERT INTO cohort_members (cohort_id, entity_id, arm, channel, p_paid, ev_gbp, task_id, status, reason) SELECT cohort_id, entity_id, arm, channel, p_paid, ev_gbp, task_id, status, reason FROM _cohort_members_copy;
DROP TABLE _cohort_members_copy;
CREATE INDEX cohort_members_task ON cohort_members (task_id);
DROP INDEX outcomes_arms;
DROP INDEX payments_ledger_rail;
DROP INDEX scout_signals_observed;
DROP INDEX letters_entity;
DROP INDEX idea_cards_hypothesis;
DROP INDEX owner_approvals_created;
DROP INDEX playbook_examples_step;
DROP INDEX experiments_status;
DROP INDEX experiments_market;
DROP INDEX decision_log_at;
DROP INDEX decision_log_graph;
DROP INDEX alerts_open;
DROP INDEX site_claims_updated;
DROP INDEX review_sessions_decided;
DROP INDEX decisions_decided;
DROP INDEX outbox_entity;
DROP INDEX outbox_created;
DROP INDEX outcomes_opportunity;
DROP INDEX outcomes_time;
DROP INDEX tasks_created;
DROP INDEX tasks_entity;
ALTER TABLE tasks DROP COLUMN entity_ref;
CREATE INDEX cost_events_at ON cost_events (at);
