-- Data layer plan, commit 0 (2026-11-26): every model, tool and print cost is written to cost_events at
-- the moment it happens, and spend caps, the digest and the Budgets page read it (not run_log).
-- playbook and step_id are copied onto each event so per-playbook caps (and their excluded steps) need
-- no join to tasks.
ALTER TABLE cost_events ADD COLUMN playbook TEXT;
ALTER TABLE cost_events ADD COLUMN step_id TEXT;
CREATE INDEX cost_events_spend ON cost_events (at, mode, playbook);
