-- Reverses 0003_indexes.sql (telemetry). Local and test use only.

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
);
INSERT INTO trigger_stats (day, rule_id, seen, matched, acted, model_calls) SELECT day, rule_id, seen, matched, acted, model_calls FROM _trigger_stats_copy;
DROP TABLE _trigger_stats_copy;
DROP INDEX dead_letters_open;
