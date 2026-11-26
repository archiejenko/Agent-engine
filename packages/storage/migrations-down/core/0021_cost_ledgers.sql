-- Reverses migrations/0021_cost_ledgers.sql (local and test only).
DROP TRIGGER pool_events_no_delete;
DROP TRIGGER pool_events_no_update;
DROP TRIGGER revenue_events_no_delete;
DROP TRIGGER revenue_events_no_update;
DROP TRIGGER cost_events_no_delete;
DROP TRIGGER cost_events_no_update;
DROP TABLE pool_events;
DROP INDEX revenue_events_at;
DROP TABLE revenue_events;
DROP INDEX cost_events_task;
DROP INDEX cost_events_run;
DROP INDEX cost_events_at;
DROP TABLE cost_events;
