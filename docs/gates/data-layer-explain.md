# Data layer: EXPLAIN QUERY PLAN for the main dashboard pages

Generated 2026-11-26 by `apps/api/src/explain.test.ts` (`EXPLAIN_REPORT=<file>`) on a synthetic world
(60 companies, 3 outreach tasks). Each page was requested once, and every SELECT it ran was explained
against its own database (core, facts or telemetry). The same test fails if a page fully scans a table
that grows with use.

**Across all 282 distinct queries** (the ones this run executed, plus every fixed SQL string in
`packages/storage`):

| | Queries with a full table scan |
|---|---|
| Before step 6 | 72 |
| After step 6 | 22 |

The 22 left are on small, bounded tables (board tiles, print batches, outreach cohorts, golden set,
graph shapes, controls), or are primary-key walks with a LIMIT.

How to read a plan line:
- `SEARCH … USING INDEX` is an index lookup;
- `SCAN … USING INDEX` walks an index in order (cheap with a LIMIT);
- a bare `SCAN t` reads the whole table.

**Two real scans this test found, and their fixes:**
- **Home:** the holdout arm counts read all of `outcomes`. They now read the partial covering index
  `outcomes_arms`.
- **Needs you:** "recent" sorted every decision with a CASE expression. It now reads `decided_at`
  newest first. This also fixes a bug: with 30 or more open decisions, the recent list used to come
  back empty.

## Home (`/api/home`)

- `SELECT * FROM outcomes WHERE dedupe_key IS NOT NULL AND observed_at >= ? AND observed_at < ? AND synthetic = 0 ORDER BY observed_at` (core)
  - SEARCH outcomes USING INDEX outcomes_time (observed_at>? AND observed_at<?)
- `SELECT * FROM site_claims WHERE synthetic = 0 ORDER BY updated_at DESC LIMIT ?` (core)
  - SCAN site_claims USING INDEX site_claims_updated
- `SELECT * FROM tasks WHERE created_at >= ? ORDER BY created_at DESC, task_id LIMIT ? OFFSET ?` (core)
  - SEARCH tasks USING INDEX tasks_created (created_at>?)
  - USE TEMP B-TREE FOR LAST TERM OF ORDER BY
- `SELECT task_id, SUM(CASE WHEN step_id = 'print_and_post' THEN cost_gbp ELSE 0 END) AS send, SUM(CASE WHEN step_id = 'print_and_post' THEN 0 ELSE cost_gbp END) AS other FROM run_log WHERE timestamp >= ? GROUP BY task_id` (telemetry)
  - SCAN run_log USING INDEX run_log_task
- `SELECT * FROM review_sessions WHERE decided_at >= ? AND synthetic = 0 ORDER BY decided_at` (core)
  - SEARCH review_sessions USING INDEX review_sessions_decided (decided_at>?)
- `SELECT * FROM outbox WHERE entity_id = ? AND status != 'blocked' ORDER BY created_at DESC` (core)
  - SEARCH outbox USING INDEX outbox_entity (entity_id=?)
- `SELECT * FROM outreach_cohorts WHERE synthetic = 0 ORDER BY created_at DESC LIMIT ?` (core)
  - SCAN outreach_cohorts
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT arm, event, COUNT(DISTINCT entity_id) AS n FROM outcomes WHERE cohort_id IS NOT NULL AND arm IS NOT NULL AND synthetic = 0 GROUP BY arm, event` (core)
  - SEARCH outcomes USING INDEX outcomes_arms (arm>?)

## Needs you (`/api/decisions`)

- `SELECT * FROM opportunities WHERE status = ? ORDER BY created_at DESC, rank LIMIT ? OFFSET ?` (core)
  - SEARCH opportunities USING INDEX opportunities_queue (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, task_id LIMIT ? OFFSET ?` (core)
  - SEARCH tasks USING INDEX tasks_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT event, COUNT(DISTINCT COALESCE(task_id, entity_id)) AS n FROM outcomes WHERE playbook = ? AND event IN ('sent', 'reply', 'paid') AND synthetic = 0 AND dry_run = 0 AND created_at <= ? AND observed_at <= ? GROUP BY ` (core)
  - SEARCH outcomes USING INDEX outcomes_learning (playbook=? AND event=? AND synthetic=? AND dry_run=? AND created_at<?)
  - USE TEMP B-TREE FOR count(DISTINCT)
- `SELECT * FROM entities WHERE entity_id = ?` (facts)
  - SEARCH entities USING INDEX sqlite_autoindex_entities_1 (entity_id=?)
- `SELECT * FROM decisions WHERE type = ? AND source_ref = ? AND status = 'open'` (core)
  - SEARCH decisions USING INDEX decisions_one_open (type=? AND source_ref=?)
- `SELECT * FROM print_batches ORDER BY created_at DESC LIMIT ?` (core)
  - SCAN print_batches
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM site_claims ORDER BY updated_at DESC LIMIT ?` (core)
  - SCAN site_claims USING INDEX site_claims_updated
- `SELECT * FROM external_effects WHERE status IN ('started', 'unknown') ORDER BY started_at DESC LIMIT ?` (core)
  - SEARCH external_effects USING INDEX external_effects_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM dead_letters WHERE resolved_at IS NULL ORDER BY received_at DESC LIMIT ?` (telemetry)
  - SEARCH dead_letters USING INDEX dead_letters_open (resolved_at=?)
- `SELECT COUNT(*) AS n FROM verified_facts f WHERE f.status = ?` (facts)
  - SCAN f USING COVERING INDEX verified_facts_field
- `SELECT f.* FROM verified_facts f WHERE f.status = ? ORDER BY f.entity_id, f.field LIMIT ? OFFSET ?` (facts)
  - SCAN f USING INDEX sqlite_autoindex_verified_facts_1
- `SELECT * FROM quarantined_matches WHERE resolved_at IS NULL ORDER BY created_at LIMIT ?` (facts)
  - SEARCH quarantined_matches USING INDEX quarantined_matches_open (resolved_at=?)
- `SELECT * FROM key_registry WHERE status = 'failing' ORDER BY name` (core)
  - SCAN key_registry USING INDEX sqlite_autoindex_key_registry_1
- `SELECT * FROM decisions WHERE status = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, money_at_stake_gbp DESC, deadline ASC, created_at ASC LIMIT ?` (core)
  - SEARCH decisions USING INDEX decisions_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM tasks WHERE task_id = ?` (core)
  - SEARCH tasks USING INDEX sqlite_autoindex_tasks_1 (task_id=?)
- `SELECT * FROM decisions WHERE status = 'open' AND deadline <= ? ORDER BY deadline` (core)
  - SEARCH decisions USING INDEX decisions_status (status=? AND deadline<?)
- `SELECT * FROM decisions WHERE decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT ?` (core)
  - SEARCH decisions USING INDEX decisions_decided (decided_at>?)

## Budgets / costs (`/api/budgets`)

- `SELECT COALESCE(SUM(CASE WHEN explore = 1 THEN actual_gbp END), 0) AS explore, COALESCE(SUM(actual_gbp), 0) AS total FROM budget_events WHERE status = 'settled' AND created_at >= ?` (core)
  - SEARCH budget_events USING INDEX budget_events_created (created_at>?)
- `SELECT value FROM controls WHERE key = ?` (core)
  - SEARCH controls USING INDEX sqlite_autoindex_controls_1 (key=?)
- `SELECT COALESCE(SUM(cost_gbp), 0) AS s FROM daily_rollups WHERE day >= ? AND mode = 'live' AND dry_run = 0 AND playbook = ?` (core)
  - SEARCH daily_rollups USING PRIMARY KEY (day>?)
- `SELECT COALESCE(SUM(amount_gbp), 0) AS s FROM cost_events WHERE at >= ? AND mode = 'live' AND dry_run = 0 AND step_id IN (?) AND playbook = ?` (core)
  - SEARCH cost_events USING INDEX cost_events_spend (at>?)
- `SELECT COALESCE(SUM(cost_gbp), 0) AS s FROM daily_rollups WHERE day >= ? AND mode = 'live' AND dry_run = 0` (core)
  - SEARCH daily_rollups USING PRIMARY KEY (day>?)
- `SELECT COALESCE(SUM(amount_gbp), 0) AS s FROM cost_events WHERE at >= ? AND mode = 'live' AND dry_run = 0 AND step_id IN (?)` (core)
  - SEARCH cost_events USING INDEX cost_events_spend (at>?)
- `SELECT COUNT(*) AS n FROM budget_events WHERE status = 'refused' AND created_at >= ?` (core)
  - SEARCH budget_events USING INDEX budget_events_created (created_at>?)
- `SELECT * FROM owner_approvals ORDER BY created_at DESC LIMIT ?` (core)
  - SCAN owner_approvals USING INDEX owner_approvals_created

## Ideas feed (`/api/ideas`)

- `SELECT c.* FROM idea_cards c JOIN (SELECT card_id, MAX(version) AS v FROM idea_cards GROUP BY card_id) m ON m.card_id = c.card_id AND m.v = c.version ORDER BY c.rank_value DESC, c.card_id LIMIT ?` (core)
  - CO-ROUTINE m
  - SCAN idea_cards USING COVERING INDEX sqlite_autoindex_idea_cards_1
  - SCAN m
  - SEARCH c USING INDEX sqlite_autoindex_idea_cards_1 (card_id=? AND version=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM decisions WHERE status = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, money_at_stake_gbp DESC, deadline ASC, created_at ASC LIMIT ?` (core)
  - SEARCH decisions USING INDEX decisions_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY

## Board (`/api/board`)

- `SELECT * FROM board_tiles ORDER BY pinned DESC, updated_at DESC` (core)
  - SCAN board_tiles
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT * FROM outcomes WHERE dedupe_key IS NOT NULL AND event = ? ORDER BY observed_at DESC, id DESC LIMIT ?` (core)
  - SEARCH outcomes USING INDEX outcomes_event (event=?)

## CRM (`/api/crm`)

- `SELECT entity_id, event, MAX(observed_at) AS at, MAX(synthetic) AS syn FROM outcomes WHERE dedupe_key IS NOT NULL AND synthetic = 0 GROUP BY entity_id, event` (core)
  - SCAN outcomes USING INDEX outcomes_entity
  - USE TEMP B-TREE FOR GROUP BY
- `SELECT entity_id, status, COUNT(*) AS n FROM letters WHERE 1 = 1 AND synthetic = 0 GROUP BY entity_id, status` (core)
  - SCAN letters USING INDEX letters_entity
  - USE TEMP B-TREE FOR GROUP BY
- `SELECT entity_id, status, monthly_gbp, updated_at, synthetic FROM site_claims WHERE 1 = 1 AND synthetic = 0 ORDER BY updated_at` (core)
  - SCAN site_claims USING INDEX site_claims_updated
- `SELECT entity_id, expected_value_gbp, status, module FROM opportunities WHERE status IN ('proposed', 'approved', 'actioned') ORDER BY created_at` (core)
  - SEARCH opportunities USING INDEX opportunities_queue (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT task_id, playbook, status, updated_at, source_ref FROM tasks WHERE status IN ('queued', 'running', 'awaiting_approval') AND synthetic = 0 ORDER BY updated_at DESC` (core)
  - SEARCH tasks USING INDEX tasks_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT substr(address, 8) AS id FROM suppressions WHERE address LIKE 'entity:%'` (core)
  - SCAN suppressions USING COVERING INDEX sqlite_autoindex_suppressions_1
- `SELECT DISTINCT o.entity_id AS id FROM outbox o JOIN suppressions s ON s.address = lower(o.recipient) WHERE o.entity_id IS NOT NULL` (core)
  - SEARCH o USING INDEX outbox_entity (entity_id>?)
  - SEARCH s USING COVERING INDEX sqlite_autoindex_suppressions_1 (address=?)
- `SELECT entity_id, name FROM entities WHERE entity_id IN (?)` (facts)
  - SEARCH entities USING INDEX sqlite_autoindex_entities_1 (entity_id=?)

## CRM company (`/api/crm/:entity`)

- `SELECT entity_id, event, MAX(observed_at) AS at, MAX(synthetic) AS syn FROM outcomes WHERE dedupe_key IS NOT NULL AND synthetic = 0 GROUP BY entity_id, event` (core)
  - SCAN outcomes USING INDEX outcomes_entity
  - USE TEMP B-TREE FOR GROUP BY
- `SELECT entity_id, status, COUNT(*) AS n FROM letters WHERE 1 = 1 AND synthetic = 0 GROUP BY entity_id, status` (core)
  - SCAN letters USING INDEX letters_entity
  - USE TEMP B-TREE FOR GROUP BY
- `SELECT entity_id, status, monthly_gbp, updated_at, synthetic FROM site_claims WHERE 1 = 1 AND synthetic = 0 ORDER BY updated_at` (core)
  - SCAN site_claims USING INDEX site_claims_updated
- `SELECT entity_id, expected_value_gbp, status, module FROM opportunities WHERE status IN ('proposed', 'approved', 'actioned') ORDER BY created_at` (core)
  - SEARCH opportunities USING INDEX opportunities_queue (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT task_id, playbook, status, updated_at, source_ref FROM tasks WHERE status IN ('queued', 'running', 'awaiting_approval') AND synthetic = 0 ORDER BY updated_at DESC` (core)
  - SEARCH tasks USING INDEX tasks_status (status=?)
  - USE TEMP B-TREE FOR ORDER BY
- `SELECT substr(address, 8) AS id FROM suppressions WHERE address LIKE 'entity:%'` (core)
  - SCAN suppressions USING COVERING INDEX sqlite_autoindex_suppressions_1
- `SELECT DISTINCT o.entity_id AS id FROM outbox o JOIN suppressions s ON s.address = lower(o.recipient) WHERE o.entity_id IS NOT NULL` (core)
  - SEARCH o USING INDEX outbox_entity (entity_id>?)
  - SEARCH s USING COVERING INDEX sqlite_autoindex_suppressions_1 (address=?)
- `SELECT entity_id, name FROM entities WHERE entity_id IN (?)` (facts)
  - SEARCH entities USING INDEX sqlite_autoindex_entities_1 (entity_id=?)
- `SELECT * FROM outbox WHERE entity_id = ? AND status != 'blocked' ORDER BY created_at DESC` (core)
  - SEARCH outbox USING INDEX outbox_entity (entity_id=?)
- `SELECT task_id, entity_id, company_name, address, demo_slug, opt_out_code, '' AS pdf_b64, flags, status, batch_id, created_at FROM letters WHERE entity_id = ? ORDER BY created_at DESC` (core)
  - SEARCH letters USING INDEX letters_entity (entity_id=?)
- `SELECT * FROM outcomes WHERE dedupe_key IS NOT NULL AND entity_id = ? ORDER BY observed_at DESC LIMIT 500` (core)
  - SEARCH outcomes USING INDEX outcomes_entity (entity_id=?)
- `SELECT * FROM tasks WHERE entity_ref = ? ORDER BY created_at DESC LIMIT 200` (core)
  - SEARCH tasks USING INDEX tasks_entity (entity_ref=?)
- `SELECT * FROM site_claims WHERE synthetic = 0 ORDER BY updated_at DESC LIMIT ?` (core)
  - SCAN site_claims USING INDEX site_claims_updated

## Inbox (`/api/inbox`)

- `SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?` (core)
  - SCAN outbox USING INDEX outbox_created
