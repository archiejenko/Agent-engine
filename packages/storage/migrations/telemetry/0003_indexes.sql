-- Data layer plan, step 6 (index audit, telemetry database): indexes for the scans that grow, found by
-- EXPLAIN QUERY PLAN over every query (docs/gates/data-layer-explain.md), and WITHOUT ROWID where the
-- key is composite and rows are small. Tables are rebuilt by copy, drop, create, copy back: rows kept.

CREATE INDEX dead_letters_open ON dead_letters (resolved_at, received_at);

-- trigger_stats: WITHOUT ROWID
CREATE TABLE _trigger_stats_copy AS SELECT * FROM trigger_stats;
DROP TABLE trigger_stats;
CREATE TABLE trigger_stats (
  day TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  matched INTEGER NOT NULL DEFAULT 0,
  acted INTEGER NOT NULL DEFAULT 0,
  model_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, rule_id)
) WITHOUT ROWID;
INSERT INTO trigger_stats (day, rule_id, seen, matched, acted, model_calls) SELECT day, rule_id, seen, matched, acted, model_calls FROM _trigger_stats_copy;
DROP TABLE _trigger_stats_copy;
