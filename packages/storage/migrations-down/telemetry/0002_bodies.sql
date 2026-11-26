-- Reverses telemetry 0002_bodies (local and test use only).
ALTER TABLE run_log DROP COLUMN body_sha256;
ALTER TABLE run_log DROP COLUMN body_size;
ALTER TABLE run_log DROP COLUMN body_key;
