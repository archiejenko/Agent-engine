-- Data layer plan, step 3: a run log step whose tool calls and output together exceed 8 KiB stores
-- both as one body in R2 (tool_calls and output are then ''). Read through bodies.ts only.
ALTER TABLE run_log ADD COLUMN body_key TEXT;
ALTER TABLE run_log ADD COLUMN body_size INTEGER;
ALTER TABLE run_log ADD COLUMN body_sha256 TEXT;
