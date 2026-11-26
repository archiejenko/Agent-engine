-- v2 Phase 3: owner approvals (v2 rule 14) and a record of budget reservations for reporting.
-- Only Archie's dashboard (behind Cloudflare Access) writes owner_approvals. Spend-tier increases and
-- L3 autonomy need one; agents have no code path that creates them.
CREATE TABLE owner_approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spend_tier', 'autonomy_l3')),
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX owner_approvals_subject ON owner_approvals (kind, subject, created_at);

-- Every reservation and how it ended (the Durable Object is the source of truth; this is the report).
CREATE TABLE budget_events (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  playbook TEXT,
  explore INTEGER NOT NULL DEFAULT 0,
  reserved_gbp REAL NOT NULL,
  actual_gbp REAL,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'released', 'refused')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX budget_events_created ON budget_events (created_at);
