-- v3 Phase 2: one queue for everything that needs Archie (rule 18), safe defaults (rule 19), digests.

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  -- What it's about (e.g. "task:<id>", "batch:<id>", "claim:<id>"); one OPEN decision per (type, source_ref).
  source_ref TEXT NOT NULL,
  summary TEXT NOT NULL,
  money_at_stake_gbp REAL NOT NULL DEFAULT 0,
  money_kind TEXT NOT NULL DEFAULT 'estimated' CHECK (money_kind IN ('real', 'estimated', 'assumed', 'none')),
  -- [{key, label, effect}]; `recommended` and `safe_default` are option keys.
  options TEXT NOT NULL,
  recommended TEXT NOT NULL,
  safe_default TEXT NOT NULL,
  deadline TEXT NOT NULL,
  -- Display-only context (draft text, letters, values to choose from). Never instructions.
  context TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'defaulted', 'superseded')),
  chosen_option TEXT,
  decided_by TEXT,
  approval_id TEXT,
  error TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE UNIQUE INDEX decisions_one_open ON decisions (type, source_ref) WHERE status = 'open';
CREATE INDEX decisions_status ON decisions (status, deadline);

-- owner_approvals gains kind 'decision' (every Archie decision writes exactly one, through one path).
CREATE TABLE owner_approvals_v3 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spend_tier', 'autonomy_l3', 'decision')),
  subject TEXT NOT NULL,
  value TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,
  decision_id TEXT
);
INSERT INTO owner_approvals_v3 (id, kind, subject, value, approved_by, note, created_at, used_at)
  SELECT id, kind, subject, value, approved_by, note, created_at, used_at FROM owner_approvals;
DROP TABLE owner_approvals;
ALTER TABLE owner_approvals_v3 RENAME TO owner_approvals;
CREATE INDEX owner_approvals_subject ON owner_approvals (kind, subject, created_at);
CREATE INDEX owner_approvals_decision ON owner_approvals (decision_id);

-- The daily digest (dashboard first; email once the mailbox port has a real sender).
CREATE TABLE digests (
  day TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
