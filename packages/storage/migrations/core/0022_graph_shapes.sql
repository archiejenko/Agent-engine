-- Graph shapes and promoted playbooks (graph plan, G0; used from G5). A shape is a hash of node kinds,
-- refs and edges (per-task config ignored). Promoted playbooks live here because a Worker can't write
-- to the git repo; each carries the owner approval that created it.
CREATE TABLE graph_shapes (
  fingerprint TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  live_runs INTEGER NOT NULL DEFAULT 0,
  met_metric INTEGER NOT NULL DEFAULT 0,
  breaches INTEGER NOT NULL DEFAULT 0,
  total_cost_gbp REAL NOT NULL DEFAULT 0,
  autonomy TEXT NOT NULL DEFAULT 'L1' CHECK (autonomy IN ('L0', 'L1', 'L2', 'L3')),
  promoted_playbook TEXT,
  promoted_version INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE promoted_playbooks (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  spec TEXT NOT NULL,
  skill_md TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'L1' CHECK (autonomy IN ('L0', 'L1', 'L2', 'L3')),
  approval_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
