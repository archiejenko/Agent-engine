-- v3 Phase 4: Vault edits. brain/ in git is the base; every edit (Archie's or an agent's) is a NEW version
-- here, so nothing is overwritten (rule 21). Agent versions must carry provenance.
CREATE TABLE note_versions (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  provenance TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (path, version)
);

CREATE INDEX note_versions_path ON note_versions (path, version);
