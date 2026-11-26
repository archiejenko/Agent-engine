DROP INDEX IF EXISTS cost_events_spend;
ALTER TABLE cost_events DROP COLUMN step_id;
ALTER TABLE cost_events DROP COLUMN playbook;
