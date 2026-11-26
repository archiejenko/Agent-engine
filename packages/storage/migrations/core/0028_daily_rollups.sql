-- Data layer plan, step 4: one row per day and slice, so the cost tracker, spend caps, digest and
-- Budgets read a few rows instead of summing every event. mode, synthetic and dry_run are part of the
-- key (dry_run at Archie's request), so sandbox, probe, planner, synthetic and dry-run money can never
-- be added into live spend. Upserted in the same batch as each cost or revenue event, so a rollup can
-- never disagree with its events. Unknown revenue_path / playbook are ''.
-- Revenue rows: mode 'live', synthetic 0, dry_run = Stripe test mode (test money is not real money).
CREATE TABLE daily_rollups (
  day TEXT NOT NULL,
  revenue_path TEXT NOT NULL,
  playbook TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'sandbox', 'probe', 'planner')),
  synthetic INTEGER NOT NULL CHECK (synthetic IN (0, 1)),
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  cost_gbp REAL NOT NULL DEFAULT 0,
  revenue_gbp REAL NOT NULL DEFAULT 0,
  cost_events INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, revenue_path, playbook, mode, synthetic, dry_run)
) WITHOUT ROWID;

-- Backfill from the events already recorded (empty remotely; local databases may have some).
INSERT INTO daily_rollups (day, revenue_path, playbook, mode, synthetic, dry_run, cost_gbp, cost_events)
SELECT substr(at, 1, 10), COALESCE(revenue_path, ''), COALESCE(playbook, ''), mode, synthetic, dry_run, SUM(amount_gbp), COUNT(*)
FROM cost_events GROUP BY substr(at, 1, 10), COALESCE(revenue_path, ''), COALESCE(playbook, ''), mode, synthetic, dry_run;

INSERT INTO daily_rollups (day, revenue_path, playbook, mode, synthetic, dry_run, revenue_gbp)
SELECT substr(settled_at, 1, 10), revenue_path, '', 'live', 0, test_mode, SUM(amount_gbp)
FROM revenue_events WHERE true GROUP BY substr(settled_at, 1, 10), revenue_path, test_mode
ON CONFLICT (day, revenue_path, playbook, mode, synthetic, dry_run) DO UPDATE SET revenue_gbp = revenue_gbp + excluded.revenue_gbp;
