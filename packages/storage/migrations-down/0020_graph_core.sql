-- Reverses migrations/0020_graph_core.sql (local and test only; D1 deploys apply up files only).
ALTER TABLE run_log DROP COLUMN node_id;
ALTER TABLE run_log DROP COLUMN graph_version;
ALTER TABLE run_log DROP COLUMN graph_id;
ALTER TABLE approvals DROP COLUMN comment;
ALTER TABLE approvals DROP COLUMN node_id;
ALTER TABLE approvals DROP COLUMN graph_version;
ALTER TABLE approvals DROP COLUMN graph_id;
DROP INDEX decision_log_subject;
DROP TABLE decision_log;
DROP TABLE graph_state_values;
DROP TABLE graph_node_runs;
DROP INDEX graph_runs_graph;
DROP TABLE graph_runs;
DROP INDEX sandbox_reports_graph;
DROP TABLE sandbox_reports;
DROP INDEX graph_specs_task;
DROP TABLE graph_specs;
