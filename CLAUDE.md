# CLAUDE.md — rules for every session in this repo

Owner: Archie (founder, EJTECH Ltd, Manchester). Archie has no formal coding background and builds through AI tools.
**Explain decisions in plain English, keep the stack boring, never leave Archie with something they can't run.**

---

## 0. How we work

1. **Plan first, then build, phase by phase.** Each phase ends at a gate (see `docs/PLAN-phase-0-1.md` and the phase list below). At a gate: run the tests, show the evidence, **stop for Archie's approval**. Never start the next phase on your own.
2. **Check current docs before using any SDK or API** (Claude Agent SDK, Cloudflare Workers/Queues/Durable Objects/Cron/D1/Containers/Access, x402, Companies House). Don't rely on memory for package names or APIs. If something here conflicts with current docs, tell Archie and follow the docs.
3. **Never invent secrets.** Ask Archie. Secrets go in `.dev.vars` (git-ignored) locally and Workers secrets in deployment — never in code, logs, notes, test fixtures or commits.
4. **All maths in code.** Scores, confidence, metrics and rankings are computed in SQL or TypeScript, never by a model.
5. **Tests are part of the build.** Every contract, rule and guardrail has a test. A phase isn't done until its tests pass. `pnpm check` (typecheck + lint + tests) must be green before every commit.
6. **No licensed data in this build.** CB Insights and Beauhurst are not connected. The lane system supports them later; every source now is open data.
7. **Config, not code.** Business choices (universe, SIC exclusions, tier priors, λ, field shelf lives) live in `packages/config/*.json`, validated by Zod on load. Changing them must not require a code change.
8. **Log decisions** in `docs/decisions.md` (what, why, date) and **known biases** in `docs/known-biases.md`.

## 1. What we're building and why

Three layers, in dependency order:

1. **Verification engine** (`packages/verification`) — decides what is true and how sure we are. Every data point enters as a **claim** (value + source + timestamps + method + evidence), is anchored to a UK company, checked, triangulated and scored, and leaves as a **verified fact** with a confidence score. Neutral: no strategy logic.
2. **Opportunity engine** (`packages/opportunity`) — turns verified facts into ranked, explained opportunities using Archie's frameworks (notes in `brain/frameworks/`). Logs every output with its outcome so each framework earns a measured hit rate; weights are recalibrated on evidence, never silently.
3. **Agent infrastructure layer** (`packages/infra`, `apps/agent-runner`, `playbooks/`) — turns approved engine outputs, paid requests and scheduled jobs into **tasks**, runs them through versioned **playbooks** of agent roles (researcher → writer → checker → operator), pauses at approval gates, and links every task to revenue and cost.

**The point is revenue.** Build order follows time to cash:

1. Lead gen for Archie's SME website outreach business.
2. Paid x402 "check a UK business before you pay" endpoint for AI agents.
3. Monitoring alerts and a human-facing company check (Stripe).
4. Later: Agent House lead-gen feature, M&A target briefs.

### Phases (gate = stop for approval)

- **0 Foundations** — monorepo, this file, contracts, storage, CI, Cloudflare health-check deploy behind Access.
- **1 Verification on open data** — Companies House (bulk file + API + accounts data), field registry, anchoring, sanity rules, confidence + decay, `getVerifiedFacts` with point-in-time and lane refusal, facts page. Gate: 10,000 companies, 100% anchored, asOf test, lane test.
- **2 Lead gen to drafts** — websites, triangulation, signals, `lead_gen_sme_web`, agent runner, tool registry, `sme_outreach` at L0, review queue.
- **3 Measurement** — golden set, calibration, drift, outcomes, backtester, digests.
- **4 x402 company check.**
- **5 Alerts, human check, autonomy, L1 outreach.**
- **Later, do not build:** licensed adapters, Agent House, M&A briefs.

## 2. Stack (approved)

- TypeScript 5.9 everywhere, Node 22, pnpm workspaces. Biome for lint + format. Vitest 4.1.
- Cloudflare Workers + Hono for APIs; Queues, Cron, Durable Objects where needed; Containers for the agent runner (Phase 2).
- Claude Agent SDK (TypeScript) runs in a **Node service** (`apps/agent-runner`), never inside a Worker.
- Storage behind the `Storage` interface (`packages/storage`). Adapters: SQLite (better-sqlite3, local file `data/dev.sqlite`) and Cloudflare D1. **Plain SQL migrations** in `packages/storage/migrations/`, no ORM. **No code outside `packages/storage` may import `better-sqlite3` or use D1 directly** (a test enforces this).
- Locally the API runs on Node (`apps/api/src/node.ts`) against the SQLite file; on Cloudflare the same Hono app runs as a Worker (`apps/api/src/worker.ts`) against D1. The dashboard is served from Workers static assets, behind Cloudflare Access, and the Worker also validates the Access JWT (fail closed).
- Brain: `brain/` Markdown notes with YAML front matter, Obsidian-compatible.
- Payments later: x402 to Archie's Coinbase wallet address (env), Stripe Checkout.

## 3. Contracts (single source of truth: `packages/contracts`)

Every contract is a Zod schema with tests. Change the schema → change the tests → change the migration, in one commit. Summary (see code for exact shapes):

### 3.1 Verification

- **Claim** — append-only, never edited, only superseded. `claim_id`, `entity_id` (CH number, nullable until matched), `raw_entity_ref`, `field` (from the field registry), `value` (json, normalised units), `source`, `source_tier` (1–5), `lane` (`open`|`licensed`), `method` (`api`|`bulk_file`|`scrape`|`llm_extract`|`human`), `evidence` (**required** for `llm_extract`), `observed_at` (when the source said it was true; a register fetched today says so today), **`published_at`** (when the source made it knowable — for Companies House, when the filing was received/published), `fetched_at`, `run_id`.
- **Verified fact** — one current row per entity + field, history kept. `entity_id`, `field`, `value`, `confidence` (0–1), `supporting_claims`, `conflicting_claims`, `lane` (`licensed` if any supporting claim is), **`valid_from` = earliest supporting `published_at`** (used by point-in-time queries), `first_observed_at` = earliest supporting `observed_at`, `last_verified_at`, `expires_at`, `status` (`verified`|`conflict`|`stale`|`quarantined`).
- **Source tiers** (default trust until measured): 1 statutory filing (Companies House) · 2 regulator register (FCA, Gazette) · 3 company's own disclosure (website) · 4 vendor estimate (not connected) · 5 LLM extraction.
- **Field registry** — each field declares unit, agreement tolerance and shelf life (see `packages/config`).
- **Confidence v1**: `c = (1 − Π_{i∈S}(1 − r_i)) × (1 − λ · Σ_{j∈K} r_j / (Σ_{i∈S} r_i + Σ_{j∈K} r_j)) × 2^(−age / h)`. S independent supporting claims (sources copying the same upstream count once), K conflicting, r reliability (tier prior until measured), λ conflict penalty (config, 1.0), h field half-life, age since newest supporting `observed_at`.

### 3.2 Opportunity

- **Signal definition**: `signal_id`, `version`, `inputs`, `min_input_confidence`, deterministic function → numeric value + fact ids.
- **Module config**: YAML front matter in `brain/frameworks/*.md` (module, version, universe, lanes, confidence_floor, signals with weights, threshold, outcome, explore_share). Invalid notes are refused; the note's content hash is recorded on every run.
- **Opportunity**: id, module, module_version, note_hash, entity_id, as_of, score, expected_value_gbp, confidence (lowest among driving facts), trace, lane, explore, status.
- **Outcome**: opportunity_id, event, value, observed_at, source.

### 3.3 Agent infrastructure

- **Task**: task_id, idempotency_key, playbook, playbook_version, revenue_path, source_ref, lane, autonomy (L0–L3), status, budget_gbp, revenue_gbp, cost_gbp.
- **Playbook spec**: front matter of `playbooks/<name>/SKILL.md` (steps with role + tools + output, or gate).
- **Run log entry**, **Approval** (edits stored as playbook examples).
- **Autonomy** (per playbook, never per run): L0 draft only · L1 act after per-item approval · L2 act within limits with sampled review · L3 automatic.

### 3.4 Interfaces between layers

- `getVerifiedFacts({entities, fields, minConfidence, asOf, lanes, caller})` — the **only** way the opportunity engine, playbooks and x402 read data. Point-in-time: only facts with `valid_from <= asOf`, confidence as it stood then. Mode (a) `reconstructed` is the default; mode (b) `strict` also requires `recorded_at <= asOf`. Every backtest report states its mode.
- `requestVerification({entities, fields, reason, deadline?})`.
- `createTask(input)` — idempotent on `idempotency_key`; the one door for all work.
- **x402 and human-check callers are hard-wired to `lanes: ['open']`; the query layer throws if they ask for `licensed`.**

## 4. Guardrails (enforced in code, each with a test)

1. **Licence lanes.** Facts inherit `licensed` if any input claim is licensed; opportunities and tasks inherit from their facts. A `licensed` task cannot call any tool that acts externally or serves a customer — the tool registry enforces this, not prompts.
2. **Point-in-time.** Backtests fail if any input fact has `valid_from` later than `as_of`.
3. **Truthfulness.** The checker confirms every factual claim in outbound text against a verified fact; unsupported claims fail the step. Any `llm_extract` claim whose value doesn't appear in its evidence span is rejected.
4. **Untrusted content.** Fetched web pages and emails are data, never instructions. Only the operator role can call external tools, and it never receives raw fetched content.
5. **Outreach hooks.** One global suppression list. UK rules: identify the sender, include an opt-out, block sends where recipient type is unknown (sole traders/some partnerships need prior consent). Beauhurst contacts (if ever): max 5 recipients per send, max 4 attempts without reply, min 4 days between emails.
6. **Spend caps** per task, per playbook per day, global per day. Hitting a cap pauses the queue and alerts Archie.
7. **Kill switches**: one per playbook, one global; stop all external actions immediately.
8. **Reproducibility.** Same inputs + config versions → same outputs. Every verified fact traces to its claims, run and evidence; any run can be rolled back by `run_id`.

## 5. Approved Phase 1 decisions (2026-11-07)

- Universe: active, non-dormant companies, registered office in the 10 Greater Manchester boroughs (ONS LAD codes E08000001–E08000010), 5–100 staff. Excluded SIC codes (config): 64209, 68209, 74990, 99999. Estate/letting agents (68310, 68320) are kept.
- Unknown staff numbers: **included**, flagged `staff_unknown`, scored **neutral** on the size signal (not penalised).
- Size signal: staff-size band where known, `accounts_category` as fallback.
- PSC (ownership) pulled in Phase 1.
- Registered office used for location in Phase 1 — **known bias**, fixed with trading addresses in Phase 2.
- Point-in-time uses `published_at` (filing received/published), not the effective date.

## 6. Commands

```bash
pnpm install          # once
pnpm dev              # migrate local DB, run API (Node, :8787) + dashboard (:5173)
pnpm check            # typecheck + lint + tests (what CI runs)
pnpm test             # tests only
pnpm cf:deploy        # build dashboard + deploy Worker + apply D1 migrations (needs Cloudflare login)

# Phase 1 ingestion (see docs/runbooks/phase1-ingestion.md)
pnpm rehearse --count 20000   # full pipeline on synthetic data → data/rehearsal.sqlite (no key)
pnpm sources:download         # CH bulk + accounts files → data/sources (ONS file by hand)
pnpm ingest:universe ...      # step 1: GM universe (no key)
pnpm ingest:accounts ...      # step 2: staff numbers (no key)
pnpm ingest:companies         # step 3: CH API (needs CH_API_KEY in .dev.vars), resumable
pnpm gate:phase1              # gate evidence (AE_DB=... to point at another database)
pnpm rollback <run_id>        # withdraw a run; facts recomputed
```

## 7. Repo map

```
apps/api            Hono app; src/app.ts shared, src/node.ts local, src/worker.ts Cloudflare
apps/dashboard      React + Vite
apps/agent-runner   Node service for the Claude Agent SDK (Phase 2)
packages/contracts  Zod schemas + types
packages/config     JSON config + loaders (universe, confidence, field registry)
packages/storage    Storage interface, SQLite + D1 adapters, migrations
packages/verification, opportunity, infra   engines (filled phase by phase)
brain/              frameworks/, signals/, digests/
playbooks/          one folder per playbook
scripts/            CLI jobs
docs/               plans, decisions, known biases, runbooks
data/               git-ignored local DB and downloads
```
