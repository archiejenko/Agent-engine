-- v3 Phase 5: the key registry. STATUS ONLY: this table never holds a key's value (rule 20).
-- status: unset (never saved) | set (saved, not yet used) | ok (last use worked) | failing (provider refused it).
CREATE TABLE key_registry (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('unset', 'set', 'ok', 'failing')),
  last_used_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  used_by TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
