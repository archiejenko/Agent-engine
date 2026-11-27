-- Unknown sends on Needs you (2026-11-27). The call's arguments are kept with its effect record, so an
-- effect whose outcome is unknown can say who it was for (recipient, company) and, if Archie marks it
-- as sent, the missing outbox row and outcome can be written without calling the provider again.
-- Keys never appear in arguments (they're injected by the registry, rule 20). Additive: old code runs.
ALTER TABLE external_effects ADD COLUMN args TEXT;
-- The grace-period query: open effects older than N minutes, newest first.
DROP INDEX external_effects_status;
CREATE INDEX external_effects_open ON external_effects (status, started_at);
