/**
 * The local workflow engine's step and event tables (data layer plan, step 2). Node only, in their own
 * file beside the three databases: on Cloudflare, Workflows keep their own step and event state, so
 * these never exist in D1. Same columns as before; workflow_steps no longer REFERENCES
 * workflow_instances (that table is in the core file).
 */
export const LOCAL_RUNTIME_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflow_steps (
  instance_id TEXT NOT NULL,
  name TEXT NOT NULL,
  output TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, name)
)`,
  `CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT
)`,
  "CREATE INDEX IF NOT EXISTS workflow_events_waiting ON workflow_events (instance_id, type, consumed_at)",
];
