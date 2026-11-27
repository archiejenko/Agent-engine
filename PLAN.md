---
type: plan
status: awaiting Archie's approval (no implementation code written)
date: 2026-11-27
supersedes: v3 Milestone D (agents and autonomy), if approved
---

# Agent Engine v4: the opportunity system

**Opportunity = Problem × Segment × Route × Channel.** Every opportunity runs the same lifecycle:

`Sense → Hypothesise → Size → Smoke test → Build minimum → Distribute → Serve → Measure → Scale | Kill | Spawn`

It runs on the same node library, guardrails and cockpit. Opportunity #1 is just the first config.

**How to read this.** Section 0 gives the conflicts with today's rules that you must rule on. Section 1
is what exists. Sections 2–7 are the design. Section 8 is the build order with gates. Sections 9–11 are
domains, cost and your decisions.

---

## 0. Before you approve: corrections and conflicts with `CLAUDE.md`

These come from the repo. Each one is either corrected here or listed as a decision in §11.

1. **The cockpit is not OpenUI.** OpenUI was reviewed and **not adopted** on 2026-11-26
   (`docs/decisions.md`). The cockpit is in-house:
   - a layout-as-data contract (`packages/contracts/src/layout.ts`);
   - panel queries (`apps/api/src/panels.ts`);
   - a component kit (`apps/dashboard/src/kit/`, built in U1–U3).

   This plan extends that kit. There's no generative UI.
2. **The idea seed is 500 ideas, not 300.** It's `brain/ideas/seed-500.csv`, imported as `hypotheses`.
   The 44-row `ranked-ideas.csv` is your shortlist.
3. **Paid data vs rule 6 ("No licensed data in this build").** OpenCorporates, Google Places and a
   contacts vendor are paid. Their terms usually allow our own use but not resale. Guardrail 1 today
   stops a `licensed` task calling any external tool, so a paid contact could never be emailed. This
   needs a new lane value. See decision 1.
4. **Frozen paths and frozen milestones.** These are all frozen today:
   - v2 Milestone B ("frozen until real outcomes exist");
   - monitoring alerts, the human report, Agent House lead gen and M&A briefs;
   - x402, which is out of v2 scope.

   This plan unfreezes only what it names:
   - x402 for **internal** routing in Phase 7;
   - the bandit allocators in Phase 5, which need real outcomes and stay advisory until they exist.

   The frozen revenue paths stay frozen. They can come back later as opportunity configs, approved by
   you like any other.
5. **Autonomy "per playbook, never per run" → per node, per opportunity.** It's still never per run.
   The ladder belongs to a node inside one opportunity's compiled graph, not to a single execution.
   Rule 14 stands: the top rung (send at volume) needs your recorded approval. So the last promotion is
   a gate card, not automatic.
6. **"My approval rate" in autonomy promotion.** Rule 12 says your decisions never feed **targeting**,
   and they still won't. They are used only to judge copy, which rule 12 allows. Allocators read the
   outcome ledger only.
7. **Name clash: the `opportunities` table already exists.** It holds Phase 2's per-company scored
   leads. I'll rename it to `lead_scores` in one migration with all code changed in the same commit.
   The new `opportunities` table is the portfolio-level object. Assumed; tell me if you'd rather keep
   the old name.
8. **The `agent-house` Worker isn't touched.** Nothing in this plan deploys to it or binds to it;
   `wrangler-config.test.ts` already fails if a binding names it. Cloud sessions never deploy (deploys
   stay the GitHub "Deploy" workflow, run by you).

## 1. Current-state audit

Legend: ✅ exists · 🟡 partial · ❌ missing.

### Layer 1: Vault + source registry

| Component | State | Where / what's missing |
|---|---|---|
| Storage | ✅ | D1 ×3 (`agent-engine`, `-facts`, `-telemetry`), SQLite locally, `Storage` interface, plain SQL migrations, placement test (no query/FK crosses a DB) |
| Claims → verified facts with provenance | ✅ | `claims`, `verified_facts`, confidence v1 + decay, `asOf`, lanes, rollback by `run_id` |
| Vault notes | ✅ | `note_versions` (agents write new versions; provenance) + `brain/` |
| Canonical business ID | 🟡 | `entities.entity_id` **is** the UK company number. No `businesses`/`external_ids`; no US IDs |
| Contacts with provenance | 🟡 | Role-based emails from websites as facts (`contact_email`); no `contacts` table, no vendor provenance |
| Signals | 🟡 | `signal_values` (facts, opportunity engine) and `scout_signals` (core, Ideas research). They need merging into one contract |
| Source registry | ❌ | `source_pauses` + drift exist; no cost/freshness/reliability/health registry, no lazy connect, no fetch cache contract |
| Markets | 🟡 | `market`/`market_key` on `scout_signals`, `idea_cards`, `experiments`; `market_buyer/industry` on `hypotheses`. No UK/US `market` + `region` columns |

### Layer 2: Node library

| Node (target) | State | Today |
|---|---|---|
| `detect_signal` | 🟡 | Signal definitions + module runner (`packages/opportunity`), scouts |
| `resolve_entity` | 🟡 | CH anchoring + website anchoring (number / postcode / name); quarantine for ambiguous matches; UK only |
| `enrich` | 🟡 | Website ingest + extractor (`website_extract` v2), CH API |
| `brief` | 🟡 | `opportunity_explain` (template fallback); no cached per-business brief |
| `verify` | 🟡 | Checker role + truthfulness rule (every claim must match a verified fact); blind verifier |
| `build_demo_page` | ✅ | `sme_letter` demo homepage (noindex, 30-day expiry) |
| `write_message` | ✅ | `sme_outreach_draft` v2, `sme_letter_draft` v2, `post_reply_draft` |
| `comply` | ✅ UK | Company-type rule, sender identity, opt-out, 90-day cooldown, trading disclosures. ❌ US |
| `send` | 🟡 | `send_email` tool via tool registry, recorded effects (rule 17), dry-run; no real `EmailSender` adapter yet |
| `handle_reply` | 🟡 | Mailbox port + inbox processing (reply stops follow-ups, opt-out suppresses); no real inbox adapter |
| `measure` | ✅ | Outcome ledger, cohorts + 15% holdout, lift, unit economics, cost ledger |
| `diagnose_failure` | ❌ | Experiments record a `kill_reason`; no classifier |
| Node contract (cost, failure modes, eval) | 🟡 | Graph node kinds + `budget` per node + G3 sandbox + probes; no per-node eval set or declared cost |

### Layer 3: Orchestration

| Component | State | Today |
|---|---|---|
| Graph compiler + interpreter | ✅ | `packages/graph`: JSON GraphSpec, 16 compiler rules, one interpreter, Workflows runtime, RunState DO |
| Opportunity compiler (config → graph) | ❌ | The G4 planner (LLM) proposes graphs per idea; nothing compiles a typed opportunity config deterministically |
| Portfolio allocator | ❌ | Weekly explore share (v2 Phase 3) and EV gate on priors only |
| Within-opportunity allocator | ❌ | Fixed cohort sizes |
| Ranking | 🟡 | `rank_value` on idea cards, EV, idea matrix; no margin per £ or asset-reuse bonus |
| Autonomy ladder | 🟡 | L0–L3 per playbook, promotion/demotion on breaches (G5); not per node |
| Idea generation from outcomes | ❌ | Scouts propose from research, not from wins |

### Layer 4: Guardrails

| Component | State | Today |
|---|---|---|
| UK compliance (PECR rules, opt-out, identity) | ✅ | Code + tests; legal check is Stage 0 of cutover |
| US compliance (CAN-SPAM) | ❌ | |
| Global suppression list | ✅ | `suppressions` (address, domain, `entity:<number>`) |
| Spend caps (task / playbook / global) + reservations | ✅ | `BudgetObject` DO, S-tiers; stage and opportunity caps ❌ |
| Kill switches (global + per playbook) | ✅ | |
| Deliverability limits per inbox/domain | ❌ | Warm-up is a manual checklist item |
| Circuit breakers | 🟡 | Source drift pauses a source; budget alerts. No bounce/complaint breaker |
| Agents can't change the safety layer | ✅ | `tests/architecture.test.ts` (rule 14). CODEOWNERS file not yet in the repo (Stage 1d) |
| Audit log | 🟡 | `external_effects`, `run_log`, `owner_approvals`; no single "what, to whom, on what basis, from which source" row |

### Layer 5: Cockpit

| Page | State |
|---|---|
| Home cockpit (panels from `home.json`), Needs you, Ideas, Board, Vault, CRM, Inbox, Controls, Budgets, Health, Metrics | ✅ (U1–U3) |
| Real-time cost tracker | ✅ cost ledger at call time + `spend_split`, `live_runs` panels |
| Mood board (problem map) | 🟡 Board has an industry × score heatmap; no problem map |
| Portfolio P&L by route / channel / market | ❌ (per playbook only) |
| Daily digest | ✅ (`digests`); needs "exceptions only" |

### Runtime and money

| Component | State |
|---|---|
| Cron + Queues (with DLQ) + Workflows + Durable Objects + R2 + KV | ✅ (live at `engine.ejtech.co.uk`, behind Access) |
| x402 endpoint (`/x402/*`, official middleware, open lane only) | ✅ built, dry-run; not live |
| Stripe (claim this site) | ✅ test mode |

**Storage choice: stay on D1.** The repo already runs three D1 databases, with a placement test,
migrations, batching and indexes, and the Worker binds them natively. Supabase would add a second
platform, a network hop from every Worker request, new secrets and a second migration system, for
nothing we need. Postgres features like full-text search and joins across databases aren't required
by any node here.

D1's limits are 10 GB per database and single-writer. They're handled the same way as before:
- split by placement;
- keep large bodies in R2.

A future `agent-engine-us` facts database is a new placement, not a new platform.

---

## 2. Schema

**Rules for every table.**
- Migrations are plain SQL, in one store each, with no cross-store foreign keys. Links across stores
  are plain text IDs checked in code.
- `market` (`UK`|`US`) and `region` (UK nation `ENG|SCO|WAL|NIR`; US state `FL`, `TX`…) go on every
  table that describes a business, a buyer, a send or money. Both are `NOT NULL` where the row is
  market-specific.
- Every row an agent writes carries `synthetic` and `dry_run` flags (rule 10). Timestamps are ISO UTC.
- **Store:** C = core, F = facts, T = telemetry. "(exists)" = already built, and the change is listed.

### 2.1 Taxonomy and opportunity (core)

| Table | Key fields |
|---|---|
| `problems` (C) | `problem_id`, `industry_code` (internal industry list, mapped to UK SIC 2007 and US NAICS 2022 by a config crosswalk), `function` (16-node taxonomy, `brain/taxonomy.md`), `problem_slug`, `statement`, `evidence_fact_ids` (json), `evidence_strength` (0–1, computed), `status` (`sensed`/`evidenced`/`retired`), `first_seen_at`, `markets_seen` (json) |
| `segments` (C) | `segment_id`, `market`, `region` (nullable = whole market), `industry_code`, `size_band`, `filters` (json: SIC/NAICS, staff band, age, licence type…), `est_population` (computed from sizing sources), `population_source`, `as_of` |
| `routes` (C) | `route_id` (`service_retainer`, `productised_tool`, `x402_api`, `marketplace_gig`, `digital_product`), `template_graph_id@version`, `default_stage_caps` (json), `cost_to_serve_model` (json), `status` |
| `channels` (C) | `channel_id` (`cold_email`, `marketplace_listing`, `seo_pages`, `agent_directory`, `x_content`, `partnership`), `template_graph_id@version`, `allowed_markets`, `compliance_pack_ids`, `status` |
| `opportunities` (C, new; old table renamed `lead_scores`) | `opportunity_id`, `version`, `problem_id`, `segment_id`, `route_id`, `channel_id`, `market`, `region`, `stage` (lifecycle enum), `bucket` (`exploit`/`adjacent`/`explore`), `config` (json, §4), `config_hash`, `compiled_graph_id@version`, `lane`, `parent_opportunity_id` (spawned from), `hypothesis_id` (seed link), `status` (`proposed`/`approved`/`running`/`paused`/`scaled`/`killed`), `spend_gbp`, `revenue_gbp`, `margin_gbp`, `observed_cac_gbp`, `observed_cost_to_serve_gbp`, `synthetic`, timestamps |
| `opportunity_stages` (C) | `opportunity_id`, `stage`, `entered_at`, `exited_at`, `cap_gbp`, `spent_gbp`, `exit_result` (`passed`/`failed`/`killed`/`breaker`), `evidence` (json: the numbers the exit rule read) |
| `diagnoses` (C) | `opportunity_id`, `stage`, `class` (`no_demand`/`wrong_channel`/`weak_offer`/`cost_to_serve_too_high`/`insufficient_data`), `rule_id`, `inputs` (json), `respawn_opportunity_id` (nullable), `at` |
| `assets` (C) | `asset_id`, `kind` (`source_connector`, `template`, `domain`, `inbox`, `endpoint`, `page`, `dataset`, `prompt`, `eval_set`, `brief`), `ref`, `market`, `region`, `created_by_opportunity_id`, `reused_by` (json), `marginal_cost_saved_gbp` (computed), `status`, `created_at` |
| `judgements` (C) | `judgement_id`, `subject_kind` (`opportunity_contract`/`stage_gate`/`exception`/`autonomy_promotion`/`budget`), `subject_id`, `verdict` (`pass`/`fail`/`comment`/`defaulted`), `reason`, `decision_id` → `decisions`/`owner_approvals` (exists; one path, rule 18), `at`. Read by evals only, never by allocators (rule 12) |

### 2.2 Businesses, IDs, contacts, signals, sources (facts)

| Table | Key fields |
|---|---|
| `businesses` (F) | `business_id` (deterministic: `gb-ch:<number>` for UK companies; `us-<state>:<entity_id>` for US registry entities; `bz:<ulid>` only when no registry ID exists), `name`, `name_normalised`, `market`, `region`, `status`, `industry_code`, `size_band`, `primary_domain`, `merged_into` (nullable), `created_at` |
| `external_ids` (F) | `business_id`, `scheme` (`uk_ch`, `us_state:<ST>`, `sam_uei`, `npi`, `usdot`, `mc`, `ein_exempt`, `domain`, `places_id`), `value`, `source_id`, `confidence`, `fetched_at`; unique (`scheme`, `value`) |
| `entities` (F, exists) | Stays as the UK Companies House record. `entity_id` = CH number = the `uk_ch` external ID, so **every existing fact, claim and test keeps working**. `claims.entity_id` and `verified_facts.entity_id` take a `business_id` for non-UK rows (a widening of the format, not a rename) |
| `contacts` (F) | `contact_id`, `business_id`, `kind` (`role_address`/`named_person`), `email`, `email_verified` (`valid`/`risky`/`invalid`/`unknown`), `verifier_source_id`, `name`, `title`, `source_id`, `lane`, `fetched_at`, `confidence`, `recipient_type` (`corporate`/`sole_trader`/`partnership`/`unknown`; drives PECR), `market`, `region` |
| `signals` (F, replaces `signal_values` + `scout_signals`) | `signal_id`, `definition_id@version`, `business_id` (nullable for market-level signals), `problem_id`, `value`, `fact_ids` (json), `market`, `region`, `observed_at`, `valid_from`, `lane`, `synthetic`. Old tables kept as read-only views for one release |
| `sources` (F) | `source_id`, `name`, `market`, `region`, `kind` (`bulk`/`api`/`scrape`/`vendor`), `tier` (1–5), `lane` (`open`/`paid_own_use`/`licensed`), `cost_model` (json: per call / per record / monthly), `freshness_target_h`, `reliability` (measured; tier prior until measured), `health` (`ok`/`degraded`/`paused`/`schema_drift`), `schema_hash`, `connected` (bool: lazy), `connected_at`, `terms_url`, `terms_checked_at`, `used_by` (json opportunity ids) |
| `source_fetches` (F) | `fetch_key` (source + normalised request), `source_id`, `fetched_at`, `expires_at`, `r2_key` (body), `cost_gbp`, `status`, `schema_hash` (cache + drift detection) |
| `briefs` (F) | `business_id`, `brief_version`, `fact_ids` (json), `body_r2_key`, `model`, `cost_gbp`, `created_at`, `expires_at`. One brief per business, shared by every opportunity |

### 2.3 Distribution, replies, money (core) and audit (telemetry)

| Table | Key fields |
|---|---|
| `touches` (C) | `touch_id`, `opportunity_id`, `node_run_id`, `business_id`, `contact_id`, `channel_id`, `inbox_id`, `market`, `region`, `arm_id` (bandit arm), `holdout` (bool, hidden in views, rule 22), `basis` (lawful basis: `corporate_b2b`/`consent`/`existing_customer`), `compliance_pack@version`, `sent_at`, `status` (`queued`/`sent`/`bounced`/`complained`/`suppressed`/`blocked`), `effect_key` (→ `external_effects`) |
| `replies` (C) | `reply_id`, `touch_id`, `mail_message_id` (→ `mail_messages`, exists), `class` (`positive`/`question`/`not_now`/`opt_out`/`bounce`/`auto_reply`/`complaint`), `class_method` (`rule`/`llm`), `routed_to`, `received_at` |
| `outcomes` (C, exists, widened) | + `market`, `region`, `arm_id`, `route_id`, `channel_id`; the ledger stays the only source for learning (rules 11–12) |
| `costs` (C) | `cost_events` (exists) + `opportunity_id`, `stage`, `node_id`, `market`, `kind` (`acquisition`/`serve`/`build`/`overhead`). Real-time tracker stays on it |
| `market_packs` (C) | `pack_id@version`, `market`, `region`, `sources` (json ids), `compliance_rule_ids`, `templates` (json), `send_windows` (json, local tz), `sending_domains`, `locale` (`en-GB`/`en-US`, currency, date format), `sandbox_report_id`, `status` (`draft`/`tested`/`active`) |
| `compliance_rules` (C) | `rule_id@version`, `market`, `region`, `channel_id`, `check` (registered deterministic function id), `params` (json), `source_url`, `checked_at`, `effective_from` |
| `inboxes` (C) | `inbox_id`, `domain`, `market`, `warmup_day`, `daily_limit` (computed), `sent_today`, `bounce_rate_7d`, `complaint_rate_7d`, `health` |
| `suppression` (C, = `suppressions`, exists) | + `scope` (`address`/`domain`/`business`), `market`, `source` (`opt_out`/`complaint`/`bounce`/`manual`/`regulator`), `expires_at` (null = forever) |
| `audit_log` (T) | `audit_id`, `at`, `actor` (`node:<id>`/`archie`/`system`), `action`, `opportunity_id`, `touch_id`, `recipient_hash` + plaintext `recipient` in core only, `basis`, `source_ids` (json), `fact_ids` (json), `compliance_pack@version`, `guardrail_hash`, `effect_key`. Append-only; never updated |

**Existing tables reused unchanged:** `tasks`, `decisions`, `owner_approvals`, `decision_log`,
`external_effects`, `graph_specs`, `graph_runs`, `graph_node_runs`, `hypotheses`, `idea_cards`,
`experiments` (becomes a stage record of an opportunity), `demo_pages`, `customers`,
`revenue_events`, `mail_messages`, `note_versions`, `pool_events`, `daily_rollups`.

---

## 3. Node contracts

Each node is a registered subgraph, `node_id@version`, in `packages/graph`. Its contract is a Zod
schema in `packages/contracts/src/nodes.ts` holding:
- inputs and outputs (typed state keys);
- `uses_llm` and why;
- `expected_cost_gbp` per run (checked against the cost ledger weekly, flagged when actual is over 1.5×);
- failure modes, each mapped to a recorded failure, never a crash;
- an `eval_set` id.

The compiler refuses a graph whose node has no contract or no eval set. Costs are estimates at today's
`models.json` prices (Opus 5.5 $4/$20 per Mtok, 0.79 GBP/USD), with the 50% Batch API discount where
marked **batch**.

**`detect_signal@1`**
- **In:** signal definition id, segment, `asOf`.
- **Out:** `signals[]` (value, fact ids).
- **LLM:** none. Signals are deterministic functions over verified facts (rule 4, all maths in code).
- **Cost:** ≈ £0 (D1 reads).
- **Failure modes:** input facts below `min_input_confidence` → skipped and counted; source paused → stage waits.
- **Eval:** fixed fixtures with known answers; point-in-time test (no fact with `valid_from` > `asOf`).

**`resolve_entity@1`**
- **In:** raw ref (name, address, domain, external IDs), market.
- **Out:** `business_id`, match method, confidence, or `quarantined`.
- **LLM:** only for ambiguous merges: two or more candidates within the score margin and no shared hard ID. Quarantine first; the LLM adjudicates from structured candidate data only. Expect ≤5% of resolves.
- **Cost:** deterministic ≈ £0; adjudication ≈ £0.006 (1.5k in / 150 out).
- **Failure modes:** no candidate → new `bz:` business only if the source is a registry; wrong merge → reversible (`merged_into` + rollback by run).
- **Eval:** golden set of 200 hand-labelled pairs per market. Precision ≥ 0.99 on auto-merges, recall reported.

**`enrich@1`**
- **In:** `business_id`, wanted fields.
- **Out:** claims (and therefore facts) for those fields.
- **LLM:** only the website extractor (`website_extract` v2, evidence-span rule). Registry and API sources are deterministic.
- **Cost:** £0 for open APIs; website ≈ £0.03 a site (3 pages ≈ 8.5k tokens; **batch** ≈ £0.015); paid sources at their `cost_model`.
- **Failure modes:** source down or over rate limit → cached result or wait; schema drift → breaker (§6); value not in evidence → claim rejected.
- **Eval:** extractor comparison fixtures + golden set accuracy.
- **Rules:** fetches go through the source registry (lazy connect + `source_fetches` cache). Never fetches a source the opportunity's market pack doesn't list.

**`brief@1`**
- **In:** `business_id`, fact ids (verified only, ≥ `confidence_floor`).
- **Out:** a cached brief (`briefs`), citing fact ids.
- **LLM:** yes. Synthesis of several facts into readable context is writing.
- **Cost:** ≈ £0.038 (8k in / 800 out); **batch** ≈ £0.019. Shared across opportunities; reused until any input fact changes or 30 days pass.
- **Failure modes:** a sentence with no fact id → that sentence is dropped by code.
- **Eval:** 30 briefs per market version, every sentence traced to a fact.

**`verify@1`** (skeptical second pass)
- **In:** any outbound or brief text, plus the fact ids it may use.
- **Out:** pass/fail per claim, rejected claims listed.
- **LLM:** yes. It splits claims and checks each against facts. Code then confirms each "supported" claim's value appears in the cited fact (truthfulness rule 3). The LLM can't pass a claim the code can't match.
- **Cost:** ≈ £0.014 (3k in / 300 out).
- **Failure modes:** unsupported claim → the step fails (no send). The verifier errors → treated as a fail.
- **Eval:** 100 seeded texts with planted false claims. Must catch ≥ 98%; false-reject ≤ 5%.

**`build_demo_page@1`**
- **In:** `business_id`, brief, page template (from market pack).
- **Out:** `demo_pages` row (noindex, expiring), asset.
- **LLM:** none (template + facts). Copy variants come from `write_message`.
- **Cost:** ≈ £0 (R2 + Worker).
- **Failure modes:** missing required fact → no page, so the touch uses the plain-email arm.
- **Eval:** snapshot tests; banner + no-imagery rules (exist).

**`write_message@1`**
- **In:** brief, offer (route), channel template, locale, arm.
- **Out:** draft (subject, body) with fact ids.
- **LLM:** yes. It's writing. The system prompt and template are prompt-cached; arms vary only the offer line.
- **Cost:** ≈ £0.011 (2k in / 300 out), less with cache.
- **Failure modes:** copy rules reject → one retry, then a recorded failure.
- **Eval:** copy-rule pass rate, verifier pass rate, your edit rate on samples.

**`comply@1`**
- **In:** draft, contact, business, channel, market pack.
- **Out:** `allow` / `block` (rule ids, reasons), lawful basis.
- **LLM:** none. Law becomes deterministic rules (§6).
- **Cost:** ≈ £0.
- **Failure modes:** unknown recipient type → block (UK), never "allow by default".
- **Eval:** a rule-by-rule fixture suite per market (each rule has a pass and a fail case).

**`send@1`**
- **In:** allowed draft, inbox (from deliverability allocator), touch.
- **Out:** `touches` row, `external_effects` row, `audit_log` row.
- **LLM:** none.
- **Cost:** provider per-email ≈ £0.001.
- **Rules:**
  - The only node with an external effect. Operator role only, never sees raw fetched content (guardrail 4).
  - Recorded before it runs and never repeated (rule 17).
  - Suppression is checked again at send time.
- **Failure modes:** provider error → effect "unknown", settled by the existing unknown-send path; breaker tripped → queued, not sent.
- **Eval:** dry-run equivalence; idempotency test.

**`handle_reply@1`**
- **In:** inbound message (untrusted).
- **Out:** reply class, routing (stop follow-ups / suppress / hand to you / book).
- **LLM:**
  - First pass is rules: bounce and complaint headers, unsubscribe keywords, auto-reply headers.
  - The LLM is used only when no rule matched (expect ~30%). It sees the message as untrusted data and outputs a class only, with no tools.
- **Cost:** ≈ £0.004 when the LLM is used.
- **Failure modes:** low confidence → class `question` → an exception for you.
- **Eval:** 150 labelled real-shaped replies; opt-outs must have 100% recall.

**`measure@1`**
- **In:** opportunity id, window.
- **Out:** stage metrics (sends, reply rate, positive rate, paid, CAC, cost to serve, margin), with 95% intervals.
- **LLM:** none.
- **Rules:** excludes synthetic rows and holdout from learning; shows them labelled.

**`diagnose_failure@1`**
- **In:** stage metrics, funnel, channel benchmarks.
- **Out:** a `diagnoses` row + optional respawn proposal.
- **LLM:** none. A decision table (§5.4); a short LLM-written explanation is optional, for the digest only.
- **Eval:** table tests on synthetic funnels with known causes.

---

## 4. Opportunity config spec (what you approve)

A Zod schema in `packages/contracts/src/opportunity-config.ts`. It's stored as JSON with its hash on
every run. Approving it is signing it: one decision card, one `owner_approvals` row.

```jsonc
{
  "opportunity_id": "opp_uk_gm_website_retainer_email",
  "version": 1,
  "problem":  { "problem_id": "prb_no_modern_website", "evidence_fact_ids": ["…"] },
  "segment":  { "segment_id": "seg_uk_gm_5_100_staff", "market": "UK", "region": "ENG",
                "filters": { "lad_codes": ["E08000001", "…"], "staff_band": "5-100", "sic_exclude": ["64209", "68209", "74990", "99999"] } },
  "route":    { "route_id": "service_retainer", "offer": { "setup_gbp": 0, "monthly_gbp": 0 } },   // you fill prices
  "channel":  { "channel_id": "cold_email", "market_pack": "uk@1" },
  "signals":  [{ "definition_id": "website_outdated@1", "min_confidence": 0.7 }],
  "arms":     { "signal": ["website_outdated", "no_website"], "offer": ["A", "B"], "region": ["ENG"] },
  "budget":   { "total_gbp": 150, "daily_max_gbp": 10 },
  "stages": {
    "smoke_test":    { "cap_gbp": 25, "max_days": 21, "units": { "sends": 50 },
                       "exit": { "pass": "positive_replies >= 2", "fail": "positive_replies == 0 && sends >= 50" } },
    "build_minimum": { "cap_gbp": 25, "max_days": 14 },
    "distribute":    { "cap_gbp": 75, "max_days": 45,
                       "exit": { "pass": "paid >= 1 && margin_per_gbp > 0", "fail": "cac_gbp > 3 * first_year_value_gbp" } },
    "serve":         { "cap_gbp": 25, "cost_to_serve_max_gbp_per_month": 40 }
  },
  "kill_rules": [
    "stage.spent_gbp >= stage.cap_gbp && !stage.passed",
    "breaker.tripped_count_7d >= 2",
    "days_since_start > 60 && paid == 0"
  ],
  "success": { "scale_when": "paid >= 3 && margin_per_gbp >= 1.5", "target_margin_per_gbp": 2.0 },
  "autonomy_ceiling": "send_sample",
  "lane": "open",
  "assets_expected": ["template", "domain", "eval_set"]
}
```

**Rules on the config:**
- **Exit and kill rules use a tiny expression grammar.** Comparisons over named metrics from
  `measure`, joined by `&&`/`||`. It's parsed and checked by the compiler, never `eval`.
- **Stage caps must add up to ≤ `budget.total_gbp`.** No cap may exceed the global daily cap, or the
  compiler refuses the config.
- **`autonomy_ceiling` can't be raised by an agent.** Raising it is a new config version (a new
  contract).
- **Prices, offers and caps are yours.** Placeholders are labelled `assumed` (rule 23), and an
  opportunity with an assumed price can't reach `distribute`.

---

## 5. Allocator and autonomy ladder

All maths lives in code (`packages/opportunity/src/allocate.ts`). Inputs are ledger outcomes and the
cost ledger only, with synthetic rows, holdout and dry-run excluded. A learning run at time T uses
outcomes recorded before T (rule 11).

### 5.1 Ranking

`score = expected_margin_per_gbp + reuse_bonus`

- **`expected_margin_per_gbp`** = (P(paid) × first-year value − expected cost to serve − expected
  acquisition cost) ÷ expected acquisition cost.
  - P(paid) is a Beta posterior per opportunity. The prior comes from its route × channel's measured
    rate, otherwise the assumed prior, labelled assumed.
- **`reuse_bonus`** = the build/connect cost this opportunity avoids by reusing existing assets
  (connected sources, templates, warmed domains, endpoints) ÷ its planned budget, capped at 0.5.

### 5.2 Portfolio allocator (weekly, Monday)

- **Three buckets:**
  - **exploit** (≥1 paid outcome and margin > 0): 70%;
  - **adjacent** (spawned from a win: shares the problem or segment with an exploit opportunity): 20%;
  - **explore** (everything else): 10%.

  An empty bucket's share moves to the next one. These shares are config.
- **Within a bucket: Thompson sampling.** Draw from each opportunity's margin-per-£ posterior and fund
  in draw order, up to each one's stage cap.
- **Floors and ceilings:**
  - any running opportunity gets at least its current stage's remaining minimum;
  - no single opportunity gets more than 40% of the week;
  - nothing exceeds the global cap or the pool's runway (`runway` panel).
- **Advisory until real data.** Until there are ≥ 3 opportunities with ≥ 1 real paid outcome each,
  the allocator **recommends**. Its split arrives as one weekly budget decision (default: last week's
  split, which spends nothing new, rule 19). After that it applies the split automatically, inside the
  weekly total you set.

### 5.3 Within-opportunity allocator

- **Arms** = signal × region × offer (from `arms` in the config).
- **Thompson sampling** on positive-reply rate during the smoke test, and on paid rate once paid
  outcomes exist.
- **Each arm keeps at least 10%** of sends until it has 30 sends, so no arm is starved on noise.
- **Holdout is untouched.** The 15% random holdout stays, outside the bandit, for lift.
- **This replaces fixed cohort sizes.** The total send count is still capped by the stage `units` and
  the deliverability allocator (inbox limits).

### 5.4 Stage exits and failure diagnosis

A stage ends when its exit rule passes, its cap is spent, `max_days` passes or a breaker trips. Before
any kill, `diagnose_failure` runs this table in order (thresholds are config):

| Class | Rule | Action |
|---|---|---|
| `insufficient_data` | < 30 delivered touches | Extend once (≤ 50% more cap), else kill |
| `wrong_channel` | Problem evidence strong (≥ 0.7) **and** open/click or reply rate < half the channel benchmark **and** deliverability OK | Spawn same problem × segment × route on the next channel (proposed, explore bucket) |
| `weak_offer` | Reply rate ≥ benchmark but positive-to-paid < 10% or most replies "not now"/"price" | Spawn with a new offer arm (needs your contract) |
| `cost_to_serve_too_high` | Paid ≥ 1 but serve cost > 60% of revenue | Kill this route; propose a more productised route for the same problem |
| `no_demand` | None of the above, evidence weak | Kill; lower the problem's prior in this segment |

Every exit, killed or not, writes its assets.

### 5.5 Autonomy ladder (per node, per opportunity)

There are four rungs. Only nodes with external effects (`send`, and later `publish`/`list`) climb all
four. Research nodes sit at R0 for good.

| Rung | Meaning | Promote when (rolling, real data only) | Demote when |
|---|---|---|---|
| **R0 research only** | No drafts | n/a | n/a |
| **D1 draft** (= L0) | Every draft goes to your review queue | ≥ 30 drafts, verifier pass ≥ 95%, your approve-without-edit ≥ 90%, 0 guardrail blocks caused by the draft | n/a |
| **S2 send sample** (= L1/L2) | Sends within caps; you review a 20% random sample after the fact | ≥ 200 sends, bounce < 2%, complaints < 0.05%, sample approval ≥ 95%, positive replies above stage pass line | verifier pass < 90% (last 20), sample approval < 85%, bounce ≥ 3%, complaints ≥ 0.08%, any compliance block traced to the node → back to D1 automatically |
| **V3 volume** (= L3) | Sends at the deliverability limit; 5% sample review | Meets S2 promote rules for 30 days → **a gate card for you** (rule 14: L3 needs your recorded approval) | Same as S2 → back to S2 automatically |

- **Promotion to D1 and S2 is automatic. Demotion is always automatic and immediate.**
- **The ladder can't climb past the config's `autonomy_ceiling`.**

### 5.6 Idea generation from outcomes

When an opportunity passes `distribute`:
- its problem's prior rises in adjacent segments (same industry, other regions or markets) and on
  adjacent routes (same problem, more productised route);
- the engine drafts new opportunity configs for the top 3. Their cost estimates come from the parent's
  real CAC and cost to serve, plus connect costs for any new source.

They arrive as proposed contracts (explore or adjacent bucket). The seed `hypotheses` stay the
starting list; spawned configs link to their parent.

---

## 6. Guardrail layer

### 6.1 How it's made immutable to agents

1. **Where it lives.** Guardrail code is in `packages/guardrails` (new; moves `comply`, suppression,
   caps, breakers and deliverability out of `infra`). Its config is in
   `packages/config/src/guardrails/` and `packages/config/src/market-packs/`.
2. **Read-only to agents, by construction:**
   - no tool in the registry writes guardrail tables (`compliance_rules`, `suppression` except
     *adding* an opt-out, `inboxes` limits, caps, breakers);
   - the graph compiler refuses any node that writes a guardrail state key;
   - `tests/architecture.test.ts` extends rule 14's scan to the new package.
3. **Changes only through you.** Guardrail config changes through a PR you merge, behind CODEOWNERS
   and branch protection (cutover Stage 1d, which becomes **required before Phase 2 ends**).
4. **Tamper evidence.** Every send records the guardrail bundle hash and the market pack version in
   `audit_log`. A send whose hash doesn't match the deployed bundle is refused.
5. **Suppression only grows.** It's append-only for agents. Removals are a recorded decision of yours.

### 6.2 Market compliance packs (deterministic rules, each with a pass and a fail test)

These are verified against current guidance at build time. The legal check stays Stage 0 of cutover.

- **UK (`uk@1`), PECR:**
  - corporate subscribers only;
  - sole traders and some partnerships need prior consent, so an `unknown` recipient type is blocked;
  - sender identified, with a working opt-out;
  - trading disclosures (Companies Act);
  - 90-day cooldown;
  - suppression checked;
  - truthful labelling (rule 15).
- **US (`us@1`), CAN-SPAM:**
  - a valid physical postal address in every email;
  - no false or misleading header or subject;
  - identified as an ad where required;
  - a clear opt-out, honoured within ≤ 10 business days (we honour it at once, on receipt);
  - no sending to harvested addresses;
  - state add-ons as region rules (later).
- **Both:** no AI voice outbound (TCPA written consent); no SMS. These channels aren't registered,
  so they can't be compiled.

### 6.3 Circuit breakers (auto-pause the graph; one exception card to you)

| Trigger | Threshold (config) | Pauses |
|---|---|---|
| Bounce spike | hard bounces > 3% over last 100 sends, or > 5 in 1 hour per inbox | the inbox + the opportunity's send node |
| Complaints | ≥ 0.08% rolling 7 days (before the 0.1% provider line) | every send node on that domain |
| Opt-out spike | > 3% of last 100 sends | the opportunity's send node |
| Spend overrun | stage spend > cap, or day spend > 120% of forecast | the opportunity (global cap stays as today) |
| Source schema drift | `schema_hash` change or validation failures > 5% of a fetch batch | the source + every opportunity using it |
| Verifier collapse | pass rate < 80% on the last 20 | the writing node (and demotes it) |
| Deliverability | inbox at its daily warm-up limit | that inbox, until tomorrow (no card) |

A tripped breaker writes `audit_log` + a decision with the safe default "stay paused". Resuming is your
call.

---

## 7. Cockpit changes (the existing in-house kit, no new app)

New panel queries go in `apps/api/src/panels.ts`; layouts in `packages/config/src/layouts/*.json`;
components from `apps/dashboard/src/kit/` (two new: `ProblemMap`, `PnlTable`).

| Page | Added |
|---|---|
| **Home** | `portfolio_pnl` KPI row (margin this month, CAC, cost to serve, runway); `breakers` strip; allocator split (`SegmentedBar`: exploit/adjacent/explore, planned vs spent). Real-time `spend_split` and `live_runs` stay |
| **Mood board** (rename Board) | `ProblemMap`: industry × function heatmap, cell = problem evidence strength, badge = opportunities running there and stage; filter by market/region. Click → the problem's evidence and opportunities |
| **Ideas** (feed) | Each card shows Problem × Segment × Route × Channel, market/region, stage, spend to date, observed CAC, cost to serve, bucket. Buttons: pass (signs the contract) / fail / comment. Diagnoses and spawned children shown inline |
| **Analytics** (extends Metrics) | `PnlTable` by opportunity / route / channel / market, with margin per £; asset library growth over time and reuse count; allocator history |
| **Controls** | Market packs (status, sandbox report), autonomy rung per node per opportunity, inbox health (warm-up day, limits, bounce/complaint rates), source registry (cost, freshness, health) |
| **Needs you / digest** | Exceptions only: contracts to sign, gates, breakers, autonomy V3 promotions, budget week. Routine runs never appear |

All new panels pass the existing `toPanelResult` filter (no holdout rows, no secrets, synthetic
labelled).

---

## 8. Phased build order with gates

Each phase ends at a gate: `pnpm gate:v4 --phase N` writes `docs/gates/v4-phaseN.md`. **I stop for your
approval at every gate.** Everything stays dry-run (rule 9) until Phase 4's live step, which you run on
your deployment.

**Phase 1: Vault schema + source registry**
1. Migrations for §2:
   - core: problems, segments, routes, channels, opportunities (+ rename old to `lead_scores`), stages, diagnoses, assets, judgements, touches, replies, market_packs, compliance_rules, inboxes;
   - facts: businesses, external_ids, contacts, signals, sources, source_fetches, briefs;
   - telemetry: audit_log.
2. Placement entries and Zod contracts for each.
3. Backfill `businesses` + `external_ids` from `entities` (`gb-ch:<number>`); merge `signal_values` + `scout_signals` into `signals` with views.
4. Source registry with lazy connect + fetch cache; register CH, Gazette, Find a Tender, Contracts Finder (UK) as `connected=false` except CH.
5. Taxonomy seed: `problems` from the 500 seed ideas' category × function × buyer; SIC↔NAICS crosswalk config.
- **Gate:** every existing test green; 100% of `entities` have a `business_id`; a fetch hits the cache the second time; an unregistered source is refused; placement test passes.

**Phase 2: Guardrail layer (before any sending exists)**
1. `packages/guardrails`: `comply` (uk@1 and us@1 packs), suppression scopes, stage/opportunity caps on `BudgetObject`, inboxes + warm-up schedule, all breakers, audit_log writer.
2. Architecture tests for immutability; CODEOWNERS file added (you turn on branch protection).
- **Gate:** each compliance rule has a pass and a fail test; each breaker trips in the sandbox from a synthetic event stream; an agent-facing file writing guardrail state fails CI.

**Phase 3: Core nodes**
1. Contracts + implementations: `enrich`, `brief`, `verify`, `write_message`, `comply`, `send`, `handle_reply` (+ `resolve_entity`, `detect_signal`, `measure` wrapped from existing code).
2. Batch API + prompt caching in the Anthropic adapter for non-urgent roles.
3. Eval sets checked in under `evals/`.
4. Real `EmailSender` + inbound adapters (provider you choose in cutover Stage 6), behind dry-run.
- **Gate:** each node passes its eval in the sandbox; per-node cost within 1.5× estimate on fakes; `send` idempotency test.

**Phase 4: Opportunity compiler, opportunity #1 end to end**
1. Opportunity config schema + compiler: config → GraphSpec from route and channel template graphs, deterministic, same config → same graph hash.
2. Lifecycle state machine with stage exits, kill rules, diagnoses, assets.
3. Opportunity #1 = today's SME website path: UK · Greater Manchester · "no modern website" signal (CH + website facts) · service retainer (claim this site) · cold email.
- **Gate:**
  - the same flow runs through the compiler (the hand-built `sme_outreach` path stays as the fallback);
  - a dry-run smoke test of 50 touches passes every guardrail;
  - **then, on your deployment, with your approval:** the first 50 real sends at S2's lower bound, each approved (D1).

**Phase 5: Margin tracking + bandit allocators**
1. Cost kinds (acquisition/serve/build) on the ledger.
2. P&L panels.
3. Portfolio allocator (advisory mode), within-opportunity bandit, ranking with reuse bonus.
4. Autonomy ladder per node.
- **Gate:** allocators reproduce hand-computed splits on fixed fixtures; synthetic/holdout exclusion tests; demotion fires on a synthetic breach within one tick.

**Phase 6: UK pack → first US state pack**
1. `uk@1` complete (Gazette, Find a Tender / Contracts Finder, planning portals connected lazily).
2. `us-fl@1`:
   - Florida Sunbiz bulk data (identity);
   - SEC EDGAR, SAM.gov, USAspending, FMCSA, NPPES (free, connected only when an approved opportunity needs them);
   - CAN-SPAM pack;
   - US domains + postal address;
   - en-US locale and USD;
   - Eastern-time send windows.
3. Pack sandbox: adding a pack runs its compliance suite and fixture fetches automatically.
4. A US resolve golden set.
- **Gate:** `us-fl@1` sandbox report green; one US opportunity runs dry end to end; no UK test changes.

**Phase 7: Outcome-driven idea generation + internal x402 routing**
1. Spawn rules (§5.6).
2. Internal `enrich`/`verify` calls go through our own `/x402/*` endpoints with an internal payer, so Agent Engine is customer #1. Each one is metered on the cost ledger at its price as revenue-neutral internal transfer.
3. A premium tier plan for signals with proven conversion (built, priced by you, still open lane only).
- **Gate:** a synthetic win spawns 3 proposals with real-data cost estimates; internal x402 calls appear in the ledger; `licensed`/`paid_own_use` data never reaches an x402 response (test).

---

## 9. Parallel track: sending domains (start now; lead time is the critical path)

There's no code in this track. It's checklist items added to `docs/live-cutover.md`. Warm-up takes
4–6 weeks before volume, so it starts this week.

1. **Buy domains:**
   - 2 UK lookalikes of ejtech (e.g. `ejtech-mail.co.uk`, `getejtech.co.uk`);
   - 3 US `.com` lookalikes.

   Never the main domain or the claim-sites domain (D6). About £10–12 each per year.
2. **DNS:** SPF, DKIM, DMARC (`p=none`, then `quarantine` after 2 clean weeks), plus a custom tracking
   domain if the provider uses one.
3. **Inboxes:** 2 per domain (10 total) at a mailbox provider. Real people's names aren't required;
   role names like `hello@` are fine and honest.
4. **Warm-up:**
   - start at ~10 emails a day per inbox;
   - double weekly while bounces stay < 2% and complaints < 0.1%;
   - stop at 40 a day per inbox in the first quarter.

   The `inboxes` table enforces it once Phase 2 lands; until then it's manual.
5. **US postal address** (needed for CAN-SPAM): a virtual mailbox address in the US, before any US send.

## 10. Cost model (monthly, estimates; every price re-checked against the vendor's page at build time)

**Assumptions.** Opus 5.5 for every LLM node (no model split). Briefs batched and shared. Per
contacted business ≈ brief £0.019 + write £0.011 + verify £0.014 + website enrich £0.015 ≈ **£0.06**.

| Item | Phase 4 (UK, 1 opportunity, ~1,500 touches/mo) | Phase 6 (UK + FL, ~4 opportunities, ~5,000 touches/mo) |
|---|---|---|
| Cloudflare Workers Paid (D1, Queues, Workflows, DO, R2 within allowances) | £4–8 | £8–15 |
| LLM (Opus 5.5, batched, cached briefs) | £90 | £250 (briefs reused across opportunities cut this) |
| Email sending provider | £12 | £35 |
| Domains (5, annualised) + mailboxes (10) | £45 | £55 |
| Email verification | £6 | £20 |
| Paid sources (contacts vendor, Google Places, OpenCorporates only if a state has no bulk file) | £0 (UK is open data) | £50–90 |
| US virtual postal address | n/a | £15 |
| **Total** | **≈ £160/month** | **≈ £430–480/month** |

Break-even for Phase 4 is about one retainer client a month at a typical SME web retainer. Your real
price goes in the config.

## 11. Open decisions for you (max 5, my recommendation first)

1. **A third data lane for paid sources.** Recommended: add `paid_own_use`. Data we paid for under
   terms that allow our own outreach:
   - may feed our own sends;
   - may **never** appear in an x402 response or a customer report;
   - is enforced in the query layer, like `licensed`.

   This amends rule 6 and guardrail 1. The alternative is open data only, which blocks a US contacts
   vendor.
2. **Approve v4 as the plan that replaces v3 Milestone D.** Recommended: yes, and lift the freeze only
   on what §0.4 names. The frozen revenue paths stay frozen. They come back only as opportunity
   configs you sign.
3. **Opportunity #1.** Recommended: the existing SME website path (Greater Manchester, "no modern
   website", claim-this-site retainer, cold email). It's built, open data, UK, and fastest to cash. It
   proves the compiler on known ground. You set the prices.
4. **First US state: Florida.** Recommended: Sunbiz publishes free bulk corporate data, it's in
   Eastern time, and it has a large SME base. The alternative is a state with paid-only registry data,
   which pushes OpenCorporates costs up front.
5. **Allocator autonomy.** Recommended: advisory (a weekly budget card) until 3 opportunities each
   have a real paid outcome, then automatic within your weekly total. The alternative is automatic
   from day one on assumed priors; I'd advise against it, because it would move money on placeholder
   numbers (rule 23).

**What I'll change in `CLAUDE.md` after approval:**
- a v4 section (this plan's phases and gates);
- autonomy per node;
- the lane decision;
- the `opportunities` → `lead_scores` rename.

**I'm stopping here for your approval.**
