-- 0006_phase5: watch lists + alerts, customers, outbox, suppression list, follow-ups.

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('per_alert', 'monthly')),
  payment_ref TEXT,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  entity_id TEXT NOT NULL,
  fields TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('webhook', 'email')),
  target TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX watches_entity ON watches (entity_id, active);

CREATE TABLE watch_alerts (
  id TEXT PRIMARY KEY,
  watch_id TEXT NOT NULL REFERENCES watches (id),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  fact_version INTEGER NOT NULL,
  task_id TEXT,
  charged_gbp REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (watch_id, entity_id, field, fact_version)
);

-- One global suppression list (emails or whole domains). Never contacted again.
CREATE TABLE suppressions (
  address TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  added_at TEXT NOT NULL
);

-- Every outbound email: sent, recorded in dry-run, or blocked (with the reason).
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  thread_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  entity_id TEXT,
  recipient TEXT NOT NULL,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'dry_run', 'blocked')),
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX outbox_thread ON outbox (thread_id, attempt);

CREATE INDEX outbox_recipient ON outbox (recipient, created_at);

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

CREATE INDEX followups_due ON followups (status, due_at);
