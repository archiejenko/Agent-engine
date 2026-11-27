-- v4 Phase 1 (PLAN.md §2.3): append-only audit of external actions: what, to whom (hashed here; the
-- plaintext recipient stays in core), on what basis, from which sources and facts, under which
-- compliance pack and guardrail bundle. Rows are never updated or deleted by application code.
CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  opportunity_id TEXT,
  touch_id TEXT,
  recipient_hash TEXT,
  basis TEXT,
  source_ids TEXT NOT NULL DEFAULT '[]',
  fact_ids TEXT NOT NULL DEFAULT '[]',
  compliance_pack TEXT,
  guardrail_hash TEXT,
  effect_key TEXT,
  market TEXT CHECK (market IN ('UK', 'US')),
  dry_run INTEGER NOT NULL DEFAULT 1,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX audit_log_opportunity ON audit_log (opportunity_id, at);
CREATE INDEX audit_log_touch ON audit_log (touch_id);
