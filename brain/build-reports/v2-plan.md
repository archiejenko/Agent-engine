# Agent Engine v2 — plan (for Archie's approval)

Written 2026-11-16. **No code has been written for v2.** This is step 0 of the v2 prompt: audit, schema
changes, new files, risks and the three questions. It ends with the decisions I need from you.

> **The feature freeze is still in force.** On 2026-11-10 you froze feature work until cutover Stage 5
> (real drafts) is done, and confirmed it again since. v2 is feature work. Approving this plan needs to
> say explicitly that v2 overrides the freeze (and whether the dry-run v2 build should happen before or
> after Stage 5). Until then I'll only answer questions about this plan.

---

## 1. What the v2 prompt assumes vs what is actually in the repo

Some things the prompt says "already exist" don't, or exist in a different shape. Existing code wins on
names; the gaps below change the size of the build.

| The prompt assumes | Reality |
|---|---|
| Cloudflare Queues with a dead-letter queue | **Missing.** Only a `QueueBus` port with `InMemoryQueue`. `wrangler.jsonc` has no queues, Durable Objects, Workflows or R2. Failed tasks end as `status = failed` (shown on Controls), with no DLQ. |
| Per-playbook evals | **Missing.** There's the 150-company *verification* golden set (`golden` table, Golden page) and synthetic phase gates. No playbook eval harness. |
| A status-and-vision doc and "revenue paths 3–6" | **Not in the repo.** `CLAUDE.md` lists 4 revenue items: 1 SME lead gen, 2 x402, 3 monitoring + human check, 4 later (Agent House, M&A). **Path 3 is already built.** I need your list (decision D2). |
| `brain/` holds build reports | Build reports, decisions and the cutover checklist live in `docs/` (`docs/gates/`, `docs/decisions.md`, `docs/live-cutover.md`). I'll write v2 reports to `brain/build-reports/` as asked and keep `docs/` as is, linking both ways. |
| A sixteen-function business taxonomy in `brain/` | **Not there.** `brain/` has two framework notes (`lead_gen_sme_web`, `x402_discovery`) and empty `digests/` and `signals/`. You'll need to supply the list (Phase 7 only, so not blocking Milestone A). |
| Tool registry, spend caps, kill switches, licence lanes, operator never sees raw content, cost attribution, idempotent `createTask`, review queue, L0–L3 with auto-demotion | **Present** (`packages/infra`: `tools.ts`, `controls.ts`, `runner.ts`, `autonomy.ts`, `tasks.ts`, `contact.ts`; `packages/verification/src/query.ts` for lanes). Note: promotion is *suggested* and needs your click today; v2 Phase 6 makes L0→L2 automatic. |

## 2. Audit per phase

Legend: **exists** / **partial** / **missing**.

### Milestone A

**Phase 1 — Outcome ledger**

| Item | Status | Where / what's missing |
|---|---|---|
| `outcomes` table | partial | `outcomes` (migration 0004): `opportunity_id, entity_id, module, event, value_bool, value_gbp, observed_at, source ∈ {human, system, verified_fact}`. Used by the backtester and calibration. Missing: `task_id`, `playbook`, `playbook_version`, `experiment_id`, `hypothesis_id`, funnel event types, estimate-vs-actual + assumption, `synthetic`, new sources (stripe, demo, inbox, simulator). **Extend this table** (rebuild migration, because SQLite can't change a CHECK constraint); keep the backtester working. |
| Other money/activity records | exists | `outbox` (emails), `payments_ledger` (x402, Stripe), `x402_requests`, `watch_alerts`, `letters`, `run_log` (cost per step), `tasks.cost_gbp/revenue_gbp`, `margins` view (Metrics). The ledger becomes the one funnel view; these stay as the detailed records. |
| Demo-page instrumentation | partial | Each letter already has an unguessable demo slug and opt-out code. Missing: visit logging, time on page, QR-vs-typed source. No cookies are used today. |
| Holdout control | missing | Module config has `explore_share` (exploration among *ranked* leads), which is not a random unranked holdout. |
| EV send gate | partial | `opportunities.expected_value_gbp` = base_win_rate × score/0.5 × deal value (from the framework note's `economics`). Missing: send cost, P(paid), letter `k` gate, the "skip registered/accountant offices" rule (today these are only *flagged*). |
| Cold-start priors | partial | `economics: { deal_value_gbp: 1500, base_win_rate: 0.02 }` in the framework note. Missing: separate reply/close priors, labelling as assumptions, Bayesian update. |
| Unit economics + human minutes | partial | Cost, revenue and margin per playbook exist. **Human minutes: missing.** |
| Synthetic flag | missing | Synthetic data lives in separate databases today (gates, screenshots); no row-level `synthetic` flag. v2 needs it on every row that learning reads. |

**Phase 2 — Runtime**

| Item | Status | Where / what's missing |
|---|---|---|
| Workflows | missing | — |
| Queues + DLQ | missing | Port exists (`QueueBus`); real binding and DLQ don't. |
| Never repeat an external action | exists | Tool idempotency (outbox, ledger references, Stripe event idempotency, x402 settle-after-success). Workflows steps will reuse it. |
| Reactive triggers | partial | Companies House streaming consumer (`verification/.../stream.ts`) turns events into re-verification requests. Missing: queue, coded trigger rules, the "model only when a rule fires" accounting. |
| Health page | partial | Controls shows caps, kill switches, alerts, outbox. Missing: running workflows, stuck steps, DLQ. |

**Phase 3 — Hard budgets**

| Item | Status | Where / what's missing |
|---|---|---|
| Spend caps | partial | `checkSpend` sums `run_log` in D1 per playbook/day and globally; on breach it pauses the queue and alerts. **Not strongly consistent** (two parallel tasks can both pass). Missing: reserve/settle, Durable Objects. |
| S-tiers, explore share (portfolio) | missing | — |

**Phase 4 — Taking money**

| Item | Status | Where / what's missing |
|---|---|---|
| Stripe Checkout + signed, idempotent webhook | exists | `ports/payments.ts` (`StripeCheckout`, `verifyStripeWebhook`), `products/stripe-events.ts`, human report (£9) and monitoring. Missing: subscriptions (monitoring v1 is one-off; noted as a cutover item), setup fee + monthly hosting, refunds/churn events. |
| "Claim this site" | missing | Demo pages exist (`/demo/:slug`, banner, noindex, 30-day expiry, disclosures). |
| Fulfilment | missing | No site hosting, content editing or publishing. Closest pattern: `human_report` (paid → L3 playbook → delivered). |
| Post-reply playbook | partial | `processInbox` stops follow-ups, handles opt-outs (email threads and letter codes) and records replies as outcomes. Missing: triage into 5 classes, drafted answers checked against facts, claim/booking links. No real inbox adapter yet (cutover item). |
| Compliance on demo pages | exists | Banner, disclosures, noindex, opt-out, expiry. Missing: checkout terms, consumer cancellation wording, privacy notice for visit logging. |

### Milestone B (brief; detailed plan after Milestone A)

| Phase | Status | Closest existing parts |
|---|---|---|
| 5 Golden set (playbooks) | partial | `approvals` + `examples` tables already store every approve/edit/reject with the edited text; the verification golden set has a harness pattern. Missing: promotion to golden cases, hidden holdout, `pnpm eval`, CI release gate. |
| 6 Earned autonomy | partial | `autonomy.ts` (`playbookStats`, promotion suggestion, demotion on breach), Controls page. Missing: automatic L0→L2, ledger-based margin windows, `MIN_EXPECTED_PAID`, fix-or-kill. |
| 7 Opportunity cards | partial | The opportunity engine (`runModule`, framework notes, traced scores, explanations) is the scoring half. Missing: fields config, taxonomy, scouts, hypothesis backlog, cards, experiments, injection suite (website extraction already treats pages as untrusted and is tested against injected instructions; reuse). |
| 8 Brain PRs | partial | `pnpm weights suggest` writes a suggested change into a *copy* of the framework note (never applied silently). Missing: bot PRs, path allowlist CI, branch protection. |
| 9 The loop | partial | Weekly digests and margin report (`pnpm digests`), nightly job. Missing: task write-back table, monthly portfolio card, model-check command. |

## 3. The three questions

### Q1. Where does `apps/agent-runner` run, and which jobs move to Workflows?

**Today:** a Node service, run locally against SQLite with fakes. `CLAUDE.md` and the Phase 2 plan say
"Cloudflare Containers at cutover". It has never been deployed.

**Recommendation: don't deploy the Node runner. Move all its production jobs onto Workers.** Everything
it does is plain TypeScript that already runs in a Worker bundle: the playbook runner, the tool
registry, the Anthropic client (`@anthropic-ai/sdk` uses `fetch`), PDF and QR rendering (pdf-lib,
qrcode, already in the Worker bundle), and the D1 storage adapter. A Container would add a second
runtime, a database bridge back to D1, and its own cost, for no capability we need.

| Runner job today | v2 home |
|---|---|
| `tick()` loop: intake approved leads, apply decisions, run queued tasks, follow-ups, inbox poll, watch alerts, weekly print batch | **Cron Trigger** every few minutes that enqueues work on a **Queue**; queue consumer runs short tasks |
| Long-running, multi-step work: fulfilment (P4), experiments (P7), weekly/monthly loops (P9) | **Workflows** (one class each) |
| Companies House streaming consumer (long-lived HTTP stream) | Workers can't hold an open stream indefinitely. Options: (a) a small **Durable Object** that holds the stream and re-connects from its saved timepoint; (b) keep it in Node on a container. **I recommend (a)** and will verify DO limits on long outbound streams when building Phase 2; if they don't fit, fall back to polling the CH API by timepoint from a Cron Trigger. |
| Bulk ingestion (500 MB CH bulk file, accounts iXBRL zips) and the rehearsal | **Stays Node, run by hand** (your laptop or a one-off container) — it's a monthly batch job, not a service. |
| Local development and tests | Node + SQLite + fakes, as today; Workflow and DO classes are thin wrappers around pure functions that are tested in Node, plus Miniflare bundle tests like the existing Worker test. |

This changes a line in `CLAUDE.md` ("Claude Agent SDK runs in a Node service") — we never used the
Agent SDK (decision logged in Phase 2); I'd update `CLAUDE.md` to say production runs on Workers,
Queues, Workflows and Durable Objects. **Decision D3.**

### Q2. How big does D1 get?

Measured on the Phase 1 rehearsal database (synthetic, same schema): **18,061 companies in the anchor
registry → 552 MB after one ingest**, i.e. **~30 KB per company**. Where it goes: claims 149 MB, fact
versions 104 MB, current facts 70 MB, observations 38 MB, plus indexes (~45% of the total).

Growth comes from history, not from new companies. A re-fetch adds an observation (~0.3 KB with its
indexes) per claim; a changed value adds a claim and a fact version (~1 KB). Website facts add roughly
half again on top of the Companies House data.

| Scope | Companies (anchor registry) | Day one | Per year of history (quarterly re-checks + changes) | Outcome ledger + demo visits |
|---|---|---|---|---|
| Greater Manchester (today) | ~18k | **~0.8 GB** (incl. websites) | **~0.6 GB/yr** | ~0.05 GB/yr at 500 sends/week |
| UK, same filters (5–100 staff) | ~0.9–1M (estimate: ~50× GM) | **~40 GB** | **~25–30 GB/yr** | ~1–2 GB/yr |

D1's limit is **10 GB per database, hard** (1 TB per account), and from 4 Nov 2026 a single query may
return at most 50 MB.

- **Greater Manchester fits in one database for ~10 years.** Nothing to build now. I'll add a size
  check to the health page that warns at 6 GB.
- **UK scale does not fit and needs a split** (not in this build; UK is out of scope):
  1. **Hot database** (one D1): current facts, entities, tasks, outcomes, letters, controls — everything
     the dashboard and runner touch. Current facts are ~5 KB/company → ~5 GB at UK scale.
  2. **History shards** (N D1 databases, e.g. 16, chosen by a hash of the company number): claims,
     observations, fact versions. Point-in-time queries are always per company or per company list,
     so each can be routed to its shard. The `Storage` interface already hides this; only the
     adapter changes.
  3. **Archive to R2:** observations and superseded fact versions older than 18 months move to R2 as
     NDJSON partitioned by month and run; backtests that reach further back read R2 (slower, rare).
- **The 50 MB result cap matters sooner than the size cap:** a few queries read every claim for a
  field across all companies (`listUsableFor(null, …)` in module runs). They need paging. That's a
  small fix and I'd do it in Phase 1 as hygiene.

### Q3. Which existing part plays each new role

| Design-note name | v2 name | What already plays the role (or "new") |
|---|---|---|
| Sensors | Scouts (P7) | Closest: website ingestion (`verification/src/sources/website`, untrusted-content rules), CH stream consumer, opportunity **signals** (`opportunity/src/signals.ts`). Scouts are new: they read external sources and emit `signals` rows only. |
| Diagnoser, Predictor, Architect | Planner (P7) | Opportunity engine: `runModule`, framework notes (`brain/frameworks/*.md`), traced scores, `explain.ts`, `opportunities` table. The planner is new; the engine supplies scores. |
| Activator | Outreach playbooks + post-reply playbook (P4) | `sme_outreach` (L1), `sme_letter` (L0), `processInbox`, follow-ups, contact cooldown. Post-reply playbook is new. |
| Operators | Fulfilment Workflow (P4) | Pattern: `human_report`, `monitoring_subscription`, `watch_alert` (paid → L3 playbook → delivered). Site fulfilment is new. |
| Governor | Safety layer | `ToolRegistry` (`infra/tools.ts`), `controls.ts` (caps, kill switches, queue pause), `autonomy.ts`, `contact.ts`, `outreach.ts` guardrails, licence lanes (`verification/query.ts`), copy rules and truth checker (`sme_outreach.ts`). |
| Librarian, lessons store | Write-back + digests (P9) | `approvals`/`examples` (your edits), weekly digests (`opportunity/src/digest.ts`), weight suggestions (`calibrate.ts`), `docs/decisions.md`. Task write-back table is new. |
| Toolsmith | — | Not in this build. |
| Outcome ledger | `outcomes` (P1) | Existing `outcomes` table, extended. |
| Budget envelope | Budget Durable Object (P3) | Wraps existing `checkSpend` + `caps` config; becomes the single source for limits. |
| Review queue / DLQ items | Review queue | `/api/review` + Review page tabs; DLQ items become a fifth tab. |
| Health page | Health | Extends Controls (no new page unless it gets crowded). |
| Golden set (playbooks) | P5 | Built on `approvals`/`examples`; harness shared with the verification golden set. |

## 4. Milestone A: schema, migrations, files

Migrations continue from 0009. Each is plain SQL, applied to SQLite and D1, with the storage test suite
run on both (as today).

**Phase 1 — Outcome ledger**
- `0010_outcome_ledger.sql`: rebuild `outcomes` with: `task_id, playbook, playbook_version,
  entity_id, opportunity_id, experiment_id, hypothesis_id, event` (CHECK on the funnel list:
  `sent, delivered, qr_scan, demo_visit, reply, reply_positive, booking, checkout_started, paid,
  refunded, churned`, plus the existing backtest events), `value_gbp, value_kind ∈ {actual, estimate},
  assumption, ms_on_page, source` (adds `stripe, demo, inbox, simulator`), `observed_at, recorded_at,
  synthetic`. Copy existing rows across (their events are kept; `synthetic` = 0).
- `synthetic` column added to `tasks`, `outbox`, `letters`, `demo_visits`, `payments_ledger` so a
  synthetic row can never feed learning even if it lands in the live database.
- `0011_holdout.sql`: `outreach_cohorts (id, created_at, seed, holdout_share, size)`,
  `cohort_members (cohort_id, entity_id, arm ∈ {ranked, holdout}, p_paid, ev_gbp, channel, reason)`.
- `0012_demo_visits.sql`: `demo_visits (slug, visited_at, source ∈ {qr, link}, ms_on_page)` — no IP,
  no user agent, no cookies.
- `0013_review_minutes.sql`: `review_sessions (item_type, item_id, opened_at, decided_at, active_ms)`.
- Config (`infra.json` / `products.json`, Zod-validated): `priors { reply_rate, close_rate,
  first_year_value_gbp }` (labelled assumptions), `holdout_share` (0.10–0.20), `letter_ev_k`,
  `skip_registered_office_flags`.
- New code: `infra/src/ledger.ts` (record, funnel, lift + interval vs holdout, unit economics),
  `infra/src/ev.ts` (P(paid) with Beta prior, point-in-time), `infra/src/cohort.ts` (deterministic
  seeded holdout draw), demo-page beacon (tiny inline script posting time on page; works without it),
  Review page timer.
- Tests: synthetic rows excluded from every learning function; review decisions never read by scoring
  (a test that fails if `ev.ts` or the scorer imports or queries `approvals`/`examples`/review tables);
  point-in-time (outcomes recorded after T are invisible at T); holdout seed reproducible; holdout sends
  pass the same compliance gates.

**Phase 2 — Runtime**
- `wrangler.jsonc`: Cron Trigger; Queues (`work`, `change-events`) each with a DLQ; Workflows
  (`FulfilmentWorkflow` now; `ExperimentWorkflow`, `LoopWorkflow` stubs for Milestone B).
- `0014_runtime.sql`: `dead_letters` (mirrors DLQ messages for the review queue), `trigger_stats`
  (day, events_seen, rules_fired, model_calls).
- Config: `trigger_rules` (field changes that matter: status → liquidation, new director, overdue
  accounts…).
- New code: `apps/api/src/queue.ts` (consumer), `apps/api/src/workflows/*.ts`, `infra/src/triggers.ts`.
  The tick logic moves from `apps/agent-runner` into shared functions the Worker calls; the Node runner
  stays for local use.
- Kill switch: every Workflow step starts with a kill-switch check and ends the instance cleanly if on.

**Phase 3 — Budgets**
- `BudgetObject` Durable Object (SQLite-backed, one per playbook / experiment / global):
  `reserve(amount, kind) → token | refused`, `settle(token, actual)`, `release(token)`, daily rollover.
  `checkSpend` calls it; `run_log` stays the audit trail; a nightly reconcile compares the two.
- `0015_spend_tiers.sql`: `owner_approvals (id, kind ∈ {s_tier, l3, budget_step, card}, subject,
  from, to, approved_by, approved_at)`; config `spend_tiers { S0..S3: £ ceilings }`, `explore_share`.
- An S-tier change can only be applied by an API route that writes `owner_approvals` from an
  Access-authenticated request; no agent tool can call it (tool registry has no such tool; a test
  asserts it).

**Phase 4 — Taking money**
- `0016_sites.sql`: `sites (id, entity_id, customer_id, status, subdomain, content, custom_domain,
  published_at)`, `subscriptions (stripe_subscription_id, site_id, status, current_period_end)`,
  `reply_triage (message_id, class, drafted_answer, task_id)`.
- Stripe: Checkout in **subscription** mode with the setup fee as a one-off line item; webhook adds
  `invoice.paid`, `customer.subscription.deleted`, `charge.refunded` (each idempotent, each written to
  the ledger with the task that earned it).
- Hosting: customer sites served by the same Worker by hostname (`<slug>.<sites domain>`), content in
  D1 (small) and assets in R2. Custom domains via Cloudflare custom hostnames — **proposed for your
  approval per site, never automatic** (and it's a cost line I'll check against current pricing at
  build time).
- `playbooks/site_fulfilment` (own autonomy track, starts L0), `playbooks/post_reply` (L0).
- Human-minutes target and over-target card.

**Gate reports:** `brain/build-reports/v2-phase-1.md` … `v2-phase-4.md`, then
`v2-milestone-a.md` with config values to set, legal questions and the updated cutover checklist.

## 5. Risks

1. **Freeze conflict** (above). Building v2 in dry-run doesn't touch live data, but it is the feature
   work you froze.
2. **Holdout bias through review.** Holdout drafts go through the same approval gate. If you can see
   which drafts are holdout, your approvals could bias the comparison. Proposal: holdout drafts look
   identical in Review; lift is measured on everyone *assigned* to each arm (intent to treat); holdout
   drafts you reject are reported as attrition. **Decision D4.**
3. **Two runtimes during the move.** Moving the tick to Workers while keeping Node for local dev risks
   drift. Mitigation: one set of pure functions, two thin callers, and the existing bundle test
   extended to run a Workflow and a DO in Miniflare.
4. **Budget counters in two places** (DO for limits, `run_log` for audit). A crash between reserve and
   settle can strand budget. Mitigation: reservations expire; nightly reconcile; tests for both.
5. **Point-in-time and synthetic leakage.** Every learning query takes an `asOf` and filters
   `synthetic = 0`; enforced by shared query helpers plus tests that fail if a learning function reads
   a table without them.
6. **Legal (I'll flag, not decide):** visit tokens tie page views to a company → pseudonymous personal
   data where the company is small or a sole trader (privacy notice needed; possibly a legal view);
   holdout sends are still marketing and need the same PECR/legitimate-interest basis; subscription
   terms and consumer cancellation rights (sole traders, partnerships); hosting liability for content
   customers edit; introductions in regulated fields (Milestone B).
7. **Hosting customer sites** is a new product surface (uptime, content, abuse). Kept minimal: static
   one-page sites only, no customer scripts, publish needs your approval.
8. **Workflows billing** now includes per-step charges (since Aug 2026). Small at our volume; I'll
   show it on the health page.
9. **Size of the build.** Milestone A is roughly the size of Phases 2 + 5 of v1 together. Milestone B
   is larger and depends on real outcomes to mean anything (you said as much).

## 6. Deferred (not built)

Director and company graph; agents that write new tools; connecting customers' own systems (accounts,
inbox, CRM); licensed data sources; phone outreach; UK-scale storage split (design above only); anything
on frozen revenue paths.

## 7. Decisions I need from you

- **D1 — Freeze.** Does v2 override the freeze? If yes: build Milestone A now in dry-run, or after
  cutover Stage 5?
- **D2 — Revenue paths 3–6.** There's no status doc. `CLAUDE.md` has: 1 SME lead gen, 2 x402,
  3 monitoring + human check (**built**), 4 Agent House / M&A (not built). Which paths are frozen?
  My assumption if you don't say: freeze no new playbooks on 3 and 4; the built monitoring and human
  check keep running as they are.
- **D3 — Runtime.** Retire the planned Node container; run production on Cron + Queues + Workflows +
  Durable Objects (Node kept for local dev and bulk ingestion). Update `CLAUDE.md` accordingly.
- **D4 — Holdout in review.** Holdout drafts unlabelled in Review, intent-to-treat lift, rejections
  reported as attrition.
- **D5 — Report location.** v2 reports in `brain/build-reports/` (as asked), existing reports stay in
  `docs/`. OK?
- **D6 — Sites domain.** Which domain hosts claimed sites (e.g. `sites.ejtech.co.uk`)? A placeholder is
  fine for the dry-run build.
- **D7 — Taxonomy** (Milestone B only): the sixteen business functions in three tiers.

Values you'll need to set before anything is live (placeholders in the build): `PRIOR_REPLY_RATE`,
`PRIOR_CLOSE_RATE`, first-year value, letter `k`, holdout %, `EXPLORE_SHARE`, S-tier ceilings,
`PRICE_SETUP_GBP`, `PRICE_MONTHLY_GBP`, human-minutes target, `MIN_EXPECTED_PAID` (Milestone B).
