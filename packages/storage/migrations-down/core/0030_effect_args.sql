-- Reverses 0030_effect_args (local and test use only).
DROP INDEX external_effects_open;
CREATE INDEX external_effects_status ON external_effects (status);
ALTER TABLE external_effects DROP COLUMN args;
