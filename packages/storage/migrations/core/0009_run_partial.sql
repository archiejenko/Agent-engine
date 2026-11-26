-- Runs that only covered part of their job (resumed after a stop, or limited to a subset) are marked
-- partial: drift monitoring ignores them, so a half-finished run can't look like a collapse in volume.
ALTER TABLE runs ADD COLUMN partial INTEGER NOT NULL DEFAULT 0 CHECK (partial IN (0, 1));
