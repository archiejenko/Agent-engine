---
type: plan
date: 2026-11-26
status: approved 2026-11-26 with three changes (dry_run in daily_rollups; cost_events as its own first commit; one body helper)
---

# Agent Engine data layer: plan (speed, efficiency, scale)

Everything below comes from reading the repo at `bd095de` and measuring it on a local copy of the
schema. No code, config, migration or Cloudflare resource has been touched.

## 0. What I found (the facts the plan rests on)

- **Schema.** 81 tables (80 plus `d1_migrations`), **70 named indexes + 80 automatic ones** (from
  primary keys and `UNIQUE`; that's your ~150), 10 triggers. Your 83 is the same set plus D1's own
  `_cf_*` tables.
- **Queries.** 335 SQL statements in `packages/storage`. Only **9** read more than one table, and only
  **2** of those would cross your proposed split:
  1. `runLog.spendSince` joins `run_log` (telemetry) to `tasks` (core). **This is the spend-cap check**
     (`controls.ts`, `budget.ts`), the digest and the Budgets page.
  2. `workflow_instances` ⨝ `workflow_steps`, which goes away in step 1.
- **The money truth today is `run_log` + `tasks.cost_gbp`, not `cost_events`.** `cost_events` is only
  written by the graph runtime and the planner. With the graph switch off (production's default), most
  spend never reaches the cost ledger. A real-time cost tracker needs every model and tool call in
  `cost_events` at the moment it happens, so step 1 fixes that (§2.3).
- **Workflows.** Production already runs on Cloudflare Workflows (`EngineWorkflow`,
  `GraphRunWorkflow`). On Cloudflare the `workflow_*` tables are only a mirror:
  - one D1 write per Workflow step (`putStep`);
  - an event log that nothing reads;
  - the instance list for the dashboard's runtime health.

  The Workflows binding can read one instance (`status()`, `subscribe()`) but **can't list instances**,
  and Workflows keeps instance state for 7 days.
- **Foreign keys that would cross databases:** `opportunities.run_id → runs` (core → facts) and
  `run_log.task_id → tasks` (telemetry → core). D1 enforces foreign keys, so both must be dropped and
  handled in the app.
- **Indexes (first pass).** `EXPLAIN QUERY PLAN` ran on 300 of the 335 statements. 32 build their SQL
  at run time and need checking by hand; 3 had nothing left to explain once the dynamic parts were
  stripped.
  - 20 named indexes look unused. At least 5 of them are probably used by those dynamic queries (the
    outcome ledger's learning and cohort queries, owner approvals, point-in-time facts), so the real
    list comes in step 6.
  - 50 queries do full table scans. Most are `ORDER BY created_at LIMIT n` on tables that will grow:
    `outbox`, `outcomes`, `alerts`, `owner_approvals`, `decision_log`, `decisions.decided_at`,
    `experiments`.

Prices and limits I've relied on (checked against Cloudflare docs, 2026-11-26), all on Workers Paid:

| Service | Included per month | Other facts used here |
|---|---|---|
| Durable Object SQLite | 25 billion rows read, 50 million rows written, 5 GB-month | 10 GB per object |
| D1 read replication | free | turned on per database (dashboard or REST); Sessions API only through the Worker binding |
| KV | 10 million reads, 1 million writes | 1 write per second to the same key |
| R2 | 10 GB, 1 million writes (Class A), 10 million reads (Class B) | |
| Workflows | | instances kept 7 days; `status()` per instance, no list |
| New D1, KV and R2 resources | | declared without IDs, created by wrangler at the first deploy; nothing remote is created before then |

## 1. The final map: every table to its store

**DO** = one Durable Object per graph run. **R2** = large bodies.

### core (`agent-engine`, the existing database)

| Area | Tables |
|---|---|
| Work and approvals | tasks, approvals, playbook_examples, review_sessions, decisions, owner_approvals, decision_log, controls, alerts, digests, key_registry, **external_effects** (rule 17, written by the tool registry next to tasks) |
| Ideas | hypotheses, hypothesis_imports, hypothesis_score_history, idea_matrix, idea_cards, idea_thread (append-only trigger kept), board_tiles, board_moves, experiments, **scout_signals** (moved from facts; see below) |
| Opportunities and outcomes | opportunities, outcomes (the outcome ledger), outreach_cohorts, cohort_members |
| Customers and outreach | customers, watches, watch_alerts, outbox, followups, **suppressions** (it's joined with outbox), letters, print_batches, demo_pages, demo_visits, site_claims, mail_messages, note_versions |
| Graph layer | graph_specs, graph_runs (summary), graph_shapes, promoted_playbooks, sandbox_reports |
| Money | budget_events, cost_events, revenue_events, pool_events (append-only triggers kept), payments_ledger, x402_requests, **daily_rollups** (new) |
| Runtime | **workflow_index** (new, a thin replacement for workflow_instances; see §2.4) |

**Why `scout_signals` moves to core.** Only the ideas and Board code use it: cards cite signal IDs,
the Board lists signals per market, and `storeSignals` writes a signal and a Board tile together.
Nothing in verification reads it. In core, those writes can share one batch.

### facts (`agent-engine-facts`, new)

| Area | Tables |
|---|---|
| Verification | runs, entities, claims (append-only triggers kept), claim_observations, claim_rejections, claim_supersessions, verified_facts, verified_fact_versions |
| Universe and ingestion | universe_members, ingest_progress, verification_requests, quarantined_matches, dropped_fields, source_pauses |
| Measurement | golden_entities, blind_checks, drift_metrics |
| Opportunity engine | signal_values, module_runs, backtests, weight_suggestions |

### telemetry (`agent-engine-telemetry`, new)

run_log, trigger_stats, runtime_status, dead_letters.

### DO: `RunState`, one per graph run, SQLite-backed

| Table | Notes |
|---|---|
| state_values | was graph_state_values |
| node_runs | was graph_node_runs, including recorded_model_output |

### Workflows' own state (in production)

workflow_steps and workflow_events are dropped from D1. workflow_instances is replaced by the thin
`workflow_index` in core.

### Local development only (one SQLite file, never in D1)

The full workflow_instances, workflow_steps and workflow_events tables stay for the Node runner's local
workflow engine, which is how every gate runs today.

### R2: `agent-engine-files`, new

The large bodies from step 3 (§3).

## 2. Step by step

### 2.1 Step 1: per-run graph state to Durable Objects

**One Durable Object per run, not per agent.** My recommendation:

- **No bottleneck.** A Durable Object handles one request at a time. A per-agent (per-playbook) object
  would queue every run of that playbook behind the others. Per run, runs never wait for each other.
- **Small, and deleted when the run ends.** A per-agent object grows forever and is billed for it.
  Per run, the object is tiny, and `deleteAll()` at the end frees the storage.
- **It matches what exists.** One Workflow instance per run already, and the run ID is the object's
  name (`idFromName(run_id)`), so nothing new needs looking up.

**A plain `DurableObject` with `ctx.storage.sql`, not the Agents SDK.** The SDK's `Agent` class is a
SQLite Durable Object plus WebSocket, scheduling and chat features this object doesn't use, and it
would add a dependency. The plain class keeps the stack boring and does exactly the same storage job.
If you'd rather have the SDK, it's a drop-in change of base class; say so.

What the object holds, and what it exposes over RPC:
- `node_runs`: `start`, `get`, `finish`, `forRun`.
- `state_values`: `put`, `latest`.
- `recorded_model_output`: kept inline under 8 KiB; above that it goes to R2 and the row keeps the key.
- **At run end, `close(summary)`:**
  1. Write the recorded model outputs to R2 as **one archive object per run**. Rule 8 (any run can be
     replayed and audited) needs them after the object is gone.
  2. Return the totals.
  3. The workflow's `finish` step writes **one D1 batch**: the `graph_runs` summary row (status, ended,
     cost totals, outcome) plus the `daily_rollups` `runs` count.
  4. Call `deleteAll()`.

Who calls it:
- the Workflow;
- the queue consumer, which runs role nodes (`runGraphNodeJob`).

Locally, the same SQL runs on one SQLite file, through a shared `RunStore` port with two
implementations: Durable Object and SQLite.

**Cost events: write one row per model or tool call straight to D1. Don't buffer in the Durable
Object.**
- It's real-time by construction. A buffer with a flush interval means the tracker is always that far
  behind, and a crash or eviction between flushes loses rows.
- The volume is small: a handful of rows per node. At 50 tasks a week that's a few thousand rows a
  month, against the 50 million included D1 rows written.
- Each event is written **in the same `db.batch()` as its `daily_rollups` row and the
  `graph_runs.cost_so_far_gbp` bump**, so the event, the rollup and the run total can't disagree.
- It keeps the G2 gate's "exactly one cost event per call" guarantee.

**Every cost path moves onto `cost_events`, not just graph runs.** That covers the old runner's model
calls (`runner.ts`), tool costs (`tools.ts`), print costs (`sme_letter.ts`) and the planner.
`spendSince` (spend caps, digest, Budgets page) then reads `daily_rollups` plus today's `cost_events` in
core, and the `run_log ⨝ tasks` join disappears. `run_log.cost_gbp` stays as telemetry only.

### 2.2 Step 2: split into three databases

- `agent-engine` stays as **core** (its ID is unchanged). New: `agent-engine-facts` and
  `agent-engine-telemetry`. No existing database is deleted.
- **Joins:** all 7 remaining multi-table queries stay inside one database. `outbox ⨝ suppressions` is
  in core; the claims, runs, universe and verified-facts queries are in facts.
- The `audit` scanner, which tests use to prove a reason never reaches the outcome ledger, will search
  all three databases and the run stores.

#### Every reference that crosses a store, and how it's handled

| Reference | From → to | Handled by |
|---|---|---|
| `opportunities.run_id` | core → facts.runs | Foreign key dropped; plain column; app looks it up (rollback by run ID already goes through facts) |
| `opportunities.entity_id`, and `entity_id` on outbox, letters, demo_pages, demo_visits, site_claims, watches, watch_alerts, cohort_members, followups, mail_messages, outcomes | core → facts.entities | App-level lookup with one batched `entities.getMany(ids)` (≤100 IDs per query) instead of one query per row. CRM, Inbox and Home already do this per row today |
| `tasks.source_ref`, `decisions.source_ref` (`…:entity:<id>`) | core → facts | App-level (unchanged) |
| idea card `evidence.fact_ids` | core → facts.verified_facts | App-level (unchanged; IDs are `entity:field`) |
| `run_log.task_id` | telemetry → core.tasks | Foreign key dropped; app-level; spend caps no longer read run_log (§2.1) |
| `dead_letters.body` (job JSON) | telemetry → core | App-level (unchanged) |
| `graph_runs.run_id` ↔ RunState Durable Object | core ↔ DO | The run ID is the object's name; summary copied to D1 at the end |
| `cost_events.run_id`, `revenue_events.run_id`, `sandbox_reports.run_id` | core → graph_runs (core) | Same database |
| R2 keys (`*_key`) | core/telemetry → R2 | Key + size + SHA-256 in the row; read through a `BlobStore` port |
| `verification_requests` raised by tasks | core → facts | Already a function call (`requestVerification`), no foreign key |

**One naming trap to fix while I'm in there.** `run_id` means two different things: a verification or
ingest run (`facts.runs`) and a graph run (`graph_runs`). I'll keep the columns as they are, since
renaming adds risk for no gain, and document it in `packages/storage/src/placement.ts`. A test then
checks every table is placed exactly once.

### 2.3 Step 3: large text to R2 (`agent-engine-files`)

**Threshold: 8 KiB.** Anything at or under that stays inline; anything over goes to R2. Always R2:
`letters.pdf_b64` (now stored as bytes, no base64) and `demo_pages.html`.

Why 8 KiB:
- Nearly every email body, note and run-log output is smaller, so lists such as Inbox → Sent (200 rows)
  stay one D1 query, with no 200 R2 reads.
- PDFs (about 50–200 KB) and demo pages (about 20 KB) never sit in D1.

Each moved column becomes `x` (inline, nullable) + `x_key` + `x_size` + `x_sha256`:

| Column | Kind | Object key |
|---|---|---|
| letters.pdf_b64 | always R2 | `letters/<task>/<sha>.pdf` |
| demo_pages.html | always R2 | `demo/<slug>/<sha>.html` |
| outbox.body | inline / R2 | `outbox/<id>/<sha>` |
| mail_messages.body | inline / R2 | `mail/<id>/<sha>` |
| note_versions.body | inline / R2 | `notes/<path>/<version>-<sha>` |
| run_log.output, run_log.tool_calls | inline / R2 | `runlog/<task>/<id>-<sha>` |
| recorded_model_output (Durable Object) | inline / R2, plus the run archive | `runs/<run_id>/…` |

**One helper for every body** (Archie's request). `packages/storage/src/bodies.ts` provides:
- `putBody(kind, id, content)`, which returns `{ inline }` or `{ key, size, sha256 }`;
- `getBody(row)`, which returns the content either way.

Every storage method that stores or returns a body calls it, so no caller ever sees a key or handles
the two cases. A static test fails if any other file reads an `*_key` body column.

How it works:
- **Write order:** the object goes to R2 first, then the row. If the row write fails, the orphan is
  harmless, and a weekly sweep can clean it up later.
- **Reads** check size and hash, and fail loudly on a mismatch.
- **Keys and secrets:** the scrubbing under rule 20 already happens before anything is stored, and
  stays first.
- **Locally,** blobs go to `data/blobs/`; in tests they're kept in memory.

### 2.4 Workflows' own state

- **Dropped from D1:** `workflow_steps` and `workflow_events`.
  - Steps are already durable inside Workflows; the D1 copy cost one write per step and nothing on
    Cloudflare read it back.
  - Events are buffered by Workflows; the D1 copy was never read on Cloudflare.
- **New: `workflow_index` in core.** One row per instance (id, workflow, playbook, dry_run, status,
  updated_at), written about 3 times per instance: start, pause, end. It exists only because the
  binding can't list instances, and the dashboard's runtime health needs the paused and errored list.
  Live status comes from `instance.status()` when you open a row.

### 2.5 Step 4: cheap dashboard reads

- **`daily_rollups`** (core), with primary key `(day, revenue_path, playbook, mode, synthetic,
  dry_run)` and columns cost_gbp, revenue_gbp, runs; WITHOUT ROWID.
  - **`mode`, `synthetic` and `dry_run` are part of the key.** Without them, sandbox, probe and planner
    spend, synthetic gate data, or dry-run spend would be added into live spend. That breaks G3 ("sandbox
    spend never appears as live") and rule 10. Live spend is `mode = 'live' AND synthetic = 0 AND
    dry_run = 0` (dry_run added at Archie's request).
  - Updated in the same batch as each cost or revenue write (an upsert), and as each run's end.
- **KV `agent-engine-cache`** for heavy dashboard aggregates: Home tiles, unit economics, CRM counts,
  Board money.
  - TTL 60 seconds (KV's minimum expiry). Keys are named by query and date range.
  - **The live cost tracker and spend caps never read KV**: they read `daily_rollups` (a single-row
    lookup), so they're never up to 60 seconds stale.
  - Writes: at most a few per minute while the dashboard is open, well under the included million a
    month.
- **D1 read replication.** Turned on for all three databases at deploy time, by you, in the dashboard.
  - Every dashboard GET uses `withSession(bookmark)`, with one bookmark per database carried in a
    cookie so you always read your own writes.
  - Writes go through `first-primary`.
  - The public x402 check reads facts through a session too. That's where replicas actually help: AI
    agents call from anywhere. For you in Manchester, near the WEUR primary, the gain is small, but it's
    free.

### 2.6 Step 5: batch writes

There's a new `storage.batch(db, fn)` unit of work: storage methods can also return their statement
instead of running it. Each agent step then makes **at most one batch per database**. A batch can't
span two databases, so a step is one core batch, one telemetry batch, and one transaction in the
run's Durable Object.

Call sites I'll convert (found by reading the code):
- **`runner.execStep`:** run_log, task cost and state, cost event and rollup, budget settle.
- **`tools.call` after the call:** the effect finishing, the task cost, the cost event and rollup.
- **`graph-runtime`:** `recordStepCosts` (currently up to N single inserts per step) and `persist`
  (state values plus the run cost).
- **Outreach send:** outbox, followup, ledger row, rollup.
- **`decide()`:** the owner approval, closing the decision and its effect.
- **Others:** `storeSignals` with the Board tile, idea card store with its decision, the experiment's
  end, letters and print batch.

The one deliberate exception is rule 17. An external call's effect row **must** be written, on its
own, before the call runs, so it can't share a batch with what happens after.

Proof: a test counts database round trips per step, before and after.

### 2.7 Step 6: audit indexes

1. Expand the 32 queries built at run time by hand, and run `EXPLAIN QUERY PLAN` on every query against
   each new database.
2. Drop indexes that nothing uses: up to 20 candidates today, final list after step 1.
3. Add indexes for the growing scans:
   - `outbox(created_at)`;
   - `outcomes(observed_at)` and `outcomes(opportunity_id, observed_at)`;
   - `alerts(id)` (already the key, no index needed);
   - `owner_approvals(created_at)`;
   - `decision_log(graph_id, at)` and `decision_log(at)`;
   - `decisions(decided_at)`;
   - `experiments(market_key)` and `experiments(status)`;
   - `idea_cards(hypothesis_id)`;
   - `playbook_examples(playbook, step_id)`;
   - `module_runs(module, created_at)`;
   - `tasks`: the `source_ref LIKE` scan becomes an exact-prefix range, or gets a stored `entity_id`
     column with an index.
4. Use **WITHOUT ROWID** where the key is composite and rows are small:
   - claim_observations, signal_values, universe_members, drift_metrics, trigger_stats, cohort_members,
     followups, ingest_progress, dropped_fields, source_pauses, daily_rollups;
   - the run store's state_values and node_runs.

   Not on wide rows (`idea_cards`, `verified_facts`, `promoted_playbooks`), where it makes things worse.
5. Add a regression test that the main dashboard queries use an index, and record the `EXPLAIN` output
   in the final report.

## 3. New wrangler bindings (`apps/api/wrangler.jsonc`)

```jsonc
"d1_databases": [
  { "binding": "DB",        "database_name": "agent-engine",           "database_id": "2714afcd-59c7-4ee1-a6ea-5251a0b08fb4", "migrations_dir": "../../packages/storage/migrations/core" },
  { "binding": "FACTS",     "database_name": "agent-engine-facts",     "migrations_dir": "../../packages/storage/migrations/facts" },
  { "binding": "TELEMETRY", "database_name": "agent-engine-telemetry", "migrations_dir": "../../packages/storage/migrations/telemetry" }
],
"r2_buckets":    [{ "binding": "FILES", "bucket_name": "agent-engine-files" }],
"kv_namespaces": [{ "binding": "CACHE" }],                    // created as agent-engine-cache at deploy
"durable_objects": { "bindings": [ …existing…, { "name": "RUN_STATE", "class_name": "RunState" } ] },
"migrations": [ …existing…, { "tag": "v3", "new_sqlite_classes": ["RunState"] } ]
```

The new databases, bucket and KV namespace have no IDs, so wrangler creates them **at your next
deploy**. Nothing is created remotely before you say so. `agent-house` and its KV namespace and bucket
are never named.

## 4. Migration files

- **`migrations/core/`:** the existing 0001–0024 stay as they are (already applied remotely; the
  history can't be rewritten), plus:
  - `0025_split.sql`: drops the tables that move out (facts, telemetry, graph state, workflow
    steps/events), adds `daily_rollups` and `workflow_index`, and adds the copied `playbook` column on
    `cost_events`;
  - `0026_blobs.sql`: the R2 key, size and hash columns, rebuilding empty tables where a column must go;
  - `0027_indexes.sql`: index drops and adds, and WITHOUT ROWID rebuilds.

  Each has a down file in `migrations-down/core/`.
- **`migrations/facts/0001_baseline.sql`:** the facts tables as they are today (claims triggers
  included), WITHOUT ROWID where agreed, plus the final indexes.
- **`migrations/telemetry/0001_baseline.sql`:** the same idea for telemetry.
- **Run store schema** (`packages/storage/src/run-store/schema.ts`): applied by the Durable Object in
  its constructor (`blockConcurrencyWhile`) and by the local SQLite store.
- **Local-only workflow tables** (`packages/storage/src/local-runtime.sql`): used by the Node runner
  only.

Locally the three databases are `data/core.sqlite`, `data/facts.sqlite` and `data/telemetry.sqlite`.
`dev.sqlite` is renamed to `core.sqlite` (empty anyway), plus `data/runs.sqlite` and `data/blobs/`.

## 5. Code changes by module

- **`packages/storage`**
  - `SqlStorage` takes `{ core, facts, telemetry }` drivers, and each namespace factory gets its own
    database.
  - `placement.ts` lists table → store.
  - New ports: `RunStore` (Durable Object and SQLite) and `BlobStore` (R2, filesystem, memory).
  - `batch()` unit of work; `daily_rollups` upsert; `entities.getMany`.
  - The D1 adapter becomes session-aware: `withSession(bookmark)` for reads, primary for writes.
  - `audit` searches every store.
- **`packages/infra`**
  - `graph-runtime` uses `RunStore`, and costs go in one batch with rollups.
  - `runner`, `tools` and `sme_letter` write `cost_events`.
  - `controls`, `budget`, `digest` and the Budgets read use `daily_rollups`.
  - `workflow` / `workflows`: the local engine uses the local-only file; the Cloudflare port writes
    `workflow_index`.
  - Mailbox, outreach, letters and Vault bodies go through `BlobStore`.
- **`apps/api`**
  - `RunState` Durable Object class.
  - The Worker wires `DB`, `FACTS`, `TELEMETRY`, `FILES`, `CACHE` and `RUN_STATE`.
  - One D1 session per request, with a bookmark cookie.
  - A KV cache helper for aggregates.
  - `/api/health` reports the migration count per database.
  - Demo pages and print PDFs are served from R2.
- **`apps/agent-runner`:** wires the three local databases, `runs.sqlite` and the blob folder; the gates
  and simulator are unchanged in behaviour.
- **`apps/dashboard`:** health shows the three databases; the Budgets page reads the live tracker. No
  new pages.
- **`scripts`:** local migrate per database; `pnpm cf:deploy` applies migrations to all three databases.
  The deploy runbook gets the read-replication step for you.
- **`docs`:** decisions log, `CLAUDE.md` storage section, deploy runbook, live-cutover checklist.

## 6. Test plan

Each commit must pass `pnpm check`, and **`wrangler d1 migrations apply --local`** for DB, FACTS and
TELEMETRY. Nothing runs with `--remote`, and nothing deploys.

1. **Placement:** every table appears in exactly one store; no SQL string touches two stores; no
   foreign key crosses a store. This is a static test over migrations and the storage source.
2. **Migrations:** up, down, up for 0025–0027 and both baselines; the local wrangler apply succeeds;
   the append-only triggers on claims, cost_events, revenue_events, pool_events and idea_thread still
   refuse UPDATE and DELETE.
3. **Run store:** the same test suite runs against the SQLite store and against the Durable Object, the
   latter via the Worker build and a local `wrangler dev` smoke run. Also:
   - a re-delivered node job never runs twice;
   - `close()` writes one summary batch and the R2 archive, then empties the object;
   - G2's crash-and-resume still passes.
4. **Real-time costs:**
   - every model and tool call, on the old runner and on graphs, writes exactly one cost event before
     the step returns;
   - the rollup equals the sum of its events;
   - a failed batch writes neither;
   - spend caps read core and fire at the same thresholds as today;
   - sandbox and planner spend never land in live rollups.
5. **R2:**
   - values at or under 8 KiB stay inline, larger ones go to R2;
   - size and hash are checked on read, and a missing object is a clear error;
   - PDFs and demo pages are served from R2;
   - no key value ever reaches a blob (rule 20).
6. **Cache and sessions:**
   - KV hit, miss and expiry;
   - the cost tracker and caps bypass KV;
   - GET requests use a session and round-trip the bookmark cookie;
   - writes go to the primary (tested against a fake D1 binding that records session use).
7. **Batching:** database round trips per agent step are counted before and after; at most one batch
   per database per step, except the rule-17 pre-write.
8. **Indexes:** an `EXPLAIN QUERY PLAN` regression test for the main dashboard queries (Home, Needs you,
   Budgets/costs, Ideas feed, Board, CRM, Inbox).
9. **Every existing gate:** phase 1–5, v2, v3, G0–G5, plus the phone layout and Worker bundle tests.

## 7. Commits (after approval)

0. **All spend onto cost_events, written at call time** (old runner, tools, print costs, planner,
   graphs). Spend caps, the digest and the Budgets page read it. **Its own commit, first, so nothing
   breaks between steps** (Archie's change). Until `daily_rollups` arrives in commit 4, the readers sum
   live `cost_events` directly.
1. Durable Object run state; cost events in one batch with rollups; Workflows' own state.
2. Three databases; placement map and tests.
3. R2 bodies.
4. daily_rollups readers, KV cache, sessions.
5. Batched writes.
6. Index audit, with the EXPLAIN report.

Then a short report.

## 8. Things I'd flag now

- **The real-time tracker depends on moving every cost path onto `cost_events`** (§2.1). Today it would
  only see graph runs.
- **Read replication gives you, as one user near the primary, little speed.** It's free and helps the
  public x402 endpoint; worth having, but don't expect the dashboard to feel faster from it.
- **Two cross-database writes can't be atomic:** a graph run's end (Durable Object + core) and a step's
  run log (telemetry) next to its costs (core). Both are made safe by idempotent keys, and money is
  never split.
- **`daily_rollups` needs `mode`, `synthetic` and `dry_run` in its key** (§2.5), or sandbox, synthetic
  or dry-run spend would count as live.
- **Two judgement calls for you:** `scout_signals` moves to core, not facts, and `workflow_index`
  replaces `workflow_instances` rather than dropping it outright. Both are explained above.
