-- v2 Phase 2: Workers runtime. Recorded external effects (no repeated external actions, rule 17),
-- workflow instances and their completed steps, dead letters, trigger statistics, runtime heartbeats.

-- One row per external tool call, written BEFORE the call runs. A retried or resumed step finds it and
-- never repeats the action: done → the stored result is returned; started/unknown → refused until a
-- human checks (or the tool confirms the first attempt didn't happen).
CREATE TABLE external_effects (
  key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  dry_run INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'done', 'unknown', 'not_happened')),
  result TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX external_effects_task ON external_effects (task_id);
CREATE INDEX external_effects_status ON external_effects (status);

CREATE TABLE workflow_instances (
  id TEXT PRIMARY KEY,
  workflow TEXT NOT NULL,
  playbook TEXT,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'sleeping', 'complete', 'errored')),
  dry_run INTEGER NOT NULL,
  wake_at TEXT,
  pause_reason TEXT,
  error TEXT,
  output TEXT,
  steps_done INTEGER NOT NULL DEFAULT 0,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX workflow_instances_status ON workflow_instances (status, wake_at);

-- Completed steps: a resumed instance replays these instead of running them again.
CREATE TABLE workflow_steps (
  instance_id TEXT NOT NULL REFERENCES workflow_instances (id),
  name TEXT NOT NULL,
  output TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, name)
);

-- Messages that failed max_retries times (the queue's dead-letter queue lands here and raises an alert).
CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,
  queue TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT,
  received_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Reactive triggers: per rule per day, events seen, matched by the cheap filter, acted on, model calls.
CREATE TABLE trigger_stats (
  day TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  acted INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule_id)
);

-- Last heartbeat per runtime component (cron, queue consumer, change feed, polling fallback).
CREATE TABLE runtime_status (
  name TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  detail TEXT
);
