# Implementation plan — Phase 0 (Foundations) and Phase 1 (Verification on open data)

Status: **DRAFT, awaiting Archie's approval.** No code is written until this is approved.
Date: 2026-11-06

---

## 1. Summary in plain English

- We build one TypeScript monorepo with three apps and five packages, as your prompt suggests, with a few small changes (section 2).
- **Phase 0** gives us the skeleton: rules file (`CLAUDE.md`), all the contracts as Zod schemas with tests, a storage layer that works on a local SQLite file and on Cloudflare D1, and CI on GitHub. One command (`pnpm dev`) runs everything on your laptop.
- **Phase 1** fills the database with real UK companies. Instead of calling the Companies House API for everything, we first download Companies House's **free monthly bulk file** to pick the Greater Manchester companies, then call the API only for the things the bulk file doesn't have (officers, filing history, charges). Staff numbers come from a third free source: the **accounts data files**, which carry the "average number of employees" figure most small companies now file electronically.
- The first 10,000 companies take roughly **3–4 hours** of unattended API calls, because Companies House allows about 600 calls per 5 minutes.
- Running costs at low volume: **about £4/month** (Cloudflare Workers Paid plan, $5) plus Claude API usage, which is zero in Phase 1 (no model calls are needed yet).

---

## 2. Final stack and what I changed from your prompt

| Area | Choice | Version (checked on npm today) | Changed? Why |
|---|---|---|---|
| Language | TypeScript | 5.9.3 | Pinned to 5.9, not the new 7.0. 7.0 is a rewrite and several tools don't support it yet. Boring wins. |
| Runtime (local) | Node.js | 22 LTS | — |
| Package manager | pnpm workspaces | 10.x | — |
| Schemas | Zod | 4.6.x | — |
| HTTP routing | Hono | 4.13.x | — |
| Node adapter for Hono | @hono/node-server | 2.1.x | **New.** Lets the same API code run locally on Node against the SQLite file (see "One database locally" below). |
| Cloudflare tooling | Wrangler | 4.158.x | — |
| Tests | Vitest | 4.1.x | Pinned to 4.1, because Cloudflare's Worker test pool (`@cloudflare/vitest-pool-workers` 0.23) only supports Vitest 4. |
| Worker tests | @cloudflare/vitest-pool-workers | 0.23.x | Used to prove the D1 adapter behaves the same as local SQLite. |
| Lint + format | Biome | 2.6.x | **Changed** from the usual ESLint + Prettier. One tool, one config file, very fast, fewer things to break. |
| Local SQLite | better-sqlite3 | 13.x | — |
| Database access | Plain SQL files + thin adapter | — | **Decision:** no ORM. Migrations are numbered `.sql` files that both SQLite and D1 run unchanged (`wrangler d1 migrations` uses this exact format). You can open them and read them. |
| YAML front matter | gray-matter + yaml | 4.0.x / 2.9.x | For the `brain/` notes and playbooks. Phase 2 onwards. |
| Dashboard | React + Vite | 19.x / 8.x | — |
| Agent runtime | @anthropic-ai/claude-agent-sdk | 0.3.x | Not used until Phase 2. Version re-checked then. |
| Script runner | tsx | 4.x | Runs TypeScript CLI scripts (e.g. the ingestion job) without a build step. |

### Repo layout (as your prompt, plus three additions)

```
/apps
  /api            Hono app. Two entry points: worker.ts (Cloudflare) and node.ts (local)
  /dashboard      React + Vite review UI
  /agent-runner   Node service for the Claude Agent SDK (empty shell until Phase 2)
/packages
  /contracts      Zod schemas + types for every contract (single source of truth)
  /storage        Storage interface, SQLite adapter, D1 adapter, migrations/*.sql
  /verification   adapters, field registry, entity resolution, sanity rules, confidence, query
  /opportunity    (empty shell until Phase 2)
  /infra          (empty shell until Phase 2)
  /config         NEW: tier priors, λ, field registry values — config, not code
/brain            frameworks/ signals/ digests/  (created now, used from Phase 2)
/playbooks        (created now, used from Phase 2)
/scripts          NEW: CLI jobs — ingest, seed, export-to-d1
/docs             NEW: this plan, runbooks, decision log
/data             NEW, git-ignored: local SQLite file + downloaded bulk files
CLAUDE.md
```

### One database locally (important simplification)

Running the API inside `wrangler dev` uses its own hidden copy of D1, while the ingestion script writes to a normal SQLite file — two databases that drift apart. To avoid that confusion:

- **Locally**, everything (ingestion script, API, dashboard) uses one file: `data/dev.sqlite`, via the Node entry point.
- **On Cloudflare**, the same API code runs as a Worker against D1.
- The same test suite runs against **both** adapters, so we know they behave identically.
- Getting data into D1: the initial 10k load is done locally, then pushed with one command (`pnpm d1:push`, which exports SQL and runs `wrangler d1 execute`). Ongoing refreshes move to Cron + Queues on Cloudflare in Phase 3, when the re-verification queue is built.

D1's per-database limit (10 GB) is far above what 10k–50k companies need (estimate: under 1 GB including claim history).

---

## 3. Where the agent runner lives (needed from Phase 2)

**Recommendation: Cloudflare Containers**, `basic` instance (¼ vCPU, 1 GiB RAM), started by a Worker when a task arrives and put to sleep when idle.

| Option | Monthly cost at low volume | Pros | Cons |
|---|---|---|---|
| **Cloudflare Containers** (recommended) | Included in the $5 Workers Paid plan up to 25 GiB-hours of memory + 375 vCPU-minutes; beyond that roughly $0.009 per hour awake. At ~2 hours awake a day: **under $1 extra.** | Same account, same deploy tool, same secrets, talks to Queues/D1 directly, scales to zero. | Container cold start (a few seconds); newer product; needs Docker to build the image (Wrangler does this). |
| Small Node host (Fly.io / Railway / Hetzner VPS) | £4–£6 flat | Very familiar, always on, no cold starts. | Second provider, second set of secrets, needs a way to reach D1 (HTTP API), you manage uptime. |

The Claude API bill will dwarf hosting either way. The agent runner code is plain Node, so moving between these later is a config change, not a rewrite.

---

## 4. Initial field registry (lead gen + x402 check)

Each field declares unit, agreement tolerance (used by triangulation in Phase 2) and shelf life (when a fact goes `stale`). All Phase 1 fields come from Companies House (tier 1) except where noted.

| Field | Unit / type | Tolerance | Shelf life | Source in Phase 1 | Used by |
|---|---|---|---|---|---|
| `company_number` | string | exact | never | bulk file / API | both |
| `company_name` | string (normalised) | exact after normalising | 90 d | bulk / API profile | both |
| `company_status` | enum (active, dissolved, liquidation, …) | exact | 7 d | API profile | both (x402 critical) |
| `company_type` | enum (ltd, plc, llp, …) | exact | 365 d | API profile | both |
| `incorporation_date` | date | exact | never | API profile | both |
| `dissolution_date` | date | exact | never | API profile | x402 |
| `registered_office_address` | object | exact after normalising | 90 d | API profile | both |
| `registered_office_postcode` | string | exact | 90 d | API profile | lead gen (region) |
| `registered_office_flags` | {undeliverable, in_dispute} | exact | 30 d | API profile | x402 |
| `sic_codes` | string[] | exact set | 365 d | API profile | lead gen (sectors) |
| `accounts_category` | enum (micro, small, full, dormant, …) | exact | 400 d | bulk file / API | lead gen (size proxy) |
| `last_accounts_made_up_to` | date | exact | 400 d | API profile | both |
| `accounts_next_due` / `accounts_overdue` | date / bool | exact | 7 d | API profile | both |
| `confirmation_statement_next_due` / `_overdue` | date / bool | exact | 7 d | API profile | both |
| `insolvency_flags` | {has_insolvency_history, has_been_liquidated, has_charges} | exact | 7 d | API profile | x402 |
| `officers_active` | list of {name, role, appointed_on, birth month/year} | exact set | 30 d | API officers | both |
| `officer_appointments` | list of {name, role, appointed_on, resigned_on} | exact set | 30 d | API officers (incl. resigned) | lead gen (`director_change_90d`) |
| `filing_events` | list of {date, category, type} | exact set | 30 d | API filing history | lead gen (`filing_health`) |
| `charges` | list of {created_on, status, satisfied_on} | exact set | 30 d | API charges | both (`new_charge_180d`) |
| `employees_average` | integer (people) | ±10% | 400 d | **accounts data file (iXBRL)**, tier 1, `bulk_file` | lead gen (5–100 filter) |
| `psc_active` | list of {name/kind, natures_of_control} | exact set | 30 d | API PSC | x402 only — **optional in Phase 1**, see questions |

Phase 2 adds: `website_url`, `website_last_modified`, `website_tech_age`, `job_postings_count` (for `hiring_momentum`), contact email domain.

Note: things like "director changed in the last 90 days" are **signals** (Phase 2), computed in code from the facts above. Facts stay raw.

---

## 5. Companies House ingestion: approach and timing

Checked against current CH guidance at build time; figures below to be re-confirmed then.

**Three free sources, used together:**

1. **Free Company Data Product (monthly bulk CSV, ~5.5M companies).** Has status, incorporation date, registered postcode, SIC codes, accounts category, number of charges. → Used to **choose the universe** without spending any API calls.
2. **Postcode → local authority lookup (ONS Postcode Directory, open data).** → Defines "Greater Manchester" precisely as the 10 GM boroughs, rather than guessing from postcode letters (SK and WA cross into Cheshire/Derbyshire).
3. **Accounts data product (iXBRL, daily/monthly zips).** → Gives `employees_average` from filed accounts, which the API doesn't expose. This is the only free way to apply "5–100 staff" reliably.

**Then the API** for each company in the universe: profile (1 call), officers (1 call), filing history (1 call), charges (1 call, **only if** the bulk file says the company has charges), PSC (optional, 1 call).

**Timing for 10,000 companies:**
- ~3 calls per company on average → ~30,000 calls.
- Limit 600 per 5 minutes = 120/min. We run at ~100/min to leave headroom → **~5 hours**; without PSC ~3–4 hours.
- Runs unattended, **resumable** (it records progress per company, so a crash or laptop sleep just picks up where it left off), with a token-bucket limiter, retry with backoff on 429/5xx, and a response cache so a re-run costs nothing.
- Bulk file download + filtering: ~10–20 minutes. iXBRL accounts parsing for the universe: ~30–60 minutes (we only parse files for companies in the universe).

**Expected universe size:** Greater Manchester active companies are in the low hundreds of thousands; after removing dormant companies and filtering 5–100 staff, I expect **15–30k**, comfortably above the 10k gate. We'll know the real number after the first bulk-file pass (a 20-minute job, no API key needed), before committing to API calls.

**Size gap to flag:** not every company files tagged accounts or discloses employee numbers. Companies with **unknown** headcount are kept in the database but marked, and you decide (question 2) whether they enter the lead-gen universe.

---

## 6. Phase 1 build details

### 6.1 Claims → facts (single source)
- Adapter turns each CH record into **claims** in contract shape; unknown fields are logged and dropped.
- **Sanity rules** run before anything becomes a fact: incorporation date in the future, dissolved company with filings after dissolution, officer appointed before birth year (+16), negative/implausible numbers, employees outside 0–1,000,000. Failed claims are stored with the rule name.
- **Entity anchoring:** Phase 1 data all carries a company number, so anchoring is an exact match (gate: 100%). The full resolver (name + postcode + domain scoring, quarantine band) is built and unit-tested now, because Phase 2 websites need it; its "middle band → LLM adjudication" step is a stub until Phase 2.
- **Confidence v1** exactly as your formula, implemented in TypeScript with tier priors and λ in `packages/config`. Proposed tier priors (reliability r before measurement): tier 1 = 0.95, tier 2 = 0.90, tier 3 = 0.75, tier 4 = 0.65, tier 5 = 0.50. λ = 1.0. Half-life per field = shelf life ÷ 2 (so a fact at the end of its shelf life has lost ~75% of its age factor); "never" fields have no decay.
- **Single-source note:** with one tier-1 source a fact scores at most 0.95 × decay. Triangulation (Phase 2) is what lifts confidence higher.

### 6.2 History and point-in-time (`getVerifiedFacts`)
- `verified_facts` keeps the current row; `verified_fact_versions` keeps every version with `recorded_at` (when *we* learned it) as well as `valid_from` (when the *source* says it became true).
- `asOf` query returns facts with `valid_from <= asOf`, with confidence **recomputed as of `asOf`** (decay measured from that date, using only claims that existed then).
- **Strict mode** (also `recorded_at <= asOf`) is available for honest backtests — see question 6.
- **Lane refusal:** the query layer takes a `caller` tag. Callers tagged `x402` or `human_check` that ask for `licensed` get an error, not filtered results. Licensed facts never leave via an `open`-only request even if the caller forgets to ask.
- `requestVerification` writes to a priority table in Phase 1; the nightly processor arrives in Phase 3.

### 6.3 Reproducibility
- Every ingestion run gets a `run_id`; claims and fact versions carry it.
- `pnpm rollback <run_id>` supersedes that run's claims and recomputes the affected facts. Tested.

### 6.4 Minimal dashboard page
- `/facts`: search by company number or name, list facts with value, confidence, status, `last_verified_at`, and click-through to supporting claims and evidence. Read-only. Local only in Phase 1 (Cloudflare Access is set up when we first deploy).

---

## 7. Tests (each guardrail and gate item has one)

Phase 0:
- Every contract: valid examples parse; invalid examples fail (e.g. `llm_extract` claim without `evidence` is rejected; confidence outside 0–1 rejected).
- Storage: identical test suite against SQLite and D1 adapters; migrations apply cleanly from empty.
- Lint/architecture test: no file outside `packages/storage` imports `better-sqlite3` or D1 types.

Phase 1:
- Field registry: unknown field → logged and dropped, not stored.
- Each sanity rule: a failing claim is stored with the rule name and never becomes a fact.
- Confidence: hand-computed examples for the formula (1 source, 2 independent, 2 copying the same upstream, conflicts, decay at 0 / half-life / shelf life).
- **Point-in-time:** insert a fact version on day 1 and a change on day 10; `asOf` day 5 returns the day-1 value with day-5 confidence; `asOf` before day 1 returns nothing.
- **Lane refusal:** a licensed fact in the DB; an `x402` caller asking for `['open']` never receives it; asking for `['licensed']` throws; a fact with one licensed supporting claim is itself `licensed`.
- Staleness: past `expires_at` → `stale` → excluded when `minConfidence > 0`.
- Rollback by `run_id` restores the previous facts.
- CH adapter: recorded API fixtures (no live calls in CI), rate limiter never exceeds the bucket, 429 triggers backoff.
- Gate script `pnpm gate:phase1` prints: companies ingested, % anchored, facts by status, and runs the two gate tests.

---

## 8. Commands you'll run

```bash
# one-time
corepack enable                      # gives you pnpm
pnpm install
cp .dev.vars.example .dev.vars       # then paste your Companies House key into it

# daily
pnpm dev          # API + dashboard on http://localhost:5173, using data/dev.sqlite
pnpm test         # all tests
pnpm check        # typecheck + lint + tests (what CI runs)

# Phase 1 jobs
pnpm ingest:universe     # downloads bulk files, builds the GM universe, shows the count (no API key needed)
pnpm ingest:companies --limit 10000   # API pull, resumable, ~3-5 hours
pnpm gate:phase1         # prints gate evidence
```

---

## 9. Secrets and accounts, in the order you need them

| When | What | Where it goes | Cost |
|---|---|---|---|
| Phase 0 | GitHub repo (exists) — enable Actions | — | free |
| Phase 0 | Cloudflare account, **Workers Paid plan** | — | $5/mo (needed for Queues, Containers, larger D1) |
| Phase 0 | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (for deploys from CI, later) | GitHub Actions secrets | free |
| Phase 1 | **Companies House developer account → REST API key** (developer.company-information.service.gov.uk, create an application, choose "REST" key) | `.dev.vars` locally; Workers secret `CH_API_KEY` | free |
| Phase 1 (end) | Cloudflare Access (Zero Trust) for the dashboard, with your email as the allowed user | Cloudflare dashboard | free up to 50 users |
| Phase 2 | Anthropic Claude API key, with a monthly spend limit set in the console | Workers secret / container secret `ANTHROPIC_API_KEY` | usage |
| Phase 4 | Coinbase wallet address (receive only — **not** a private key) + CDP account if facilitator needs it | env var `X402_PAY_TO` | free |
| Phase 5 | Stripe account + secret key + webhook secret | Workers secrets | per transaction |
| Phase 5 | Sending domain DNS (SPF/DKIM/DMARC) + email provider key | Workers secrets | small |

I will never put any of these in code, logs, notes or commits. `.dev.vars` is git-ignored from the first commit.

---

## 10. Questions for you

1. **Universe for the first run.** Proposal: active companies, registered office in the 10 Greater Manchester boroughs, not dormant, 5–100 employees. Any **sectors to include or exclude** (by SIC code)? My suggestion: exclude holding companies (SIC 64209/70100), property letting shells (68209), and dormant/non-trading (99999) — they don't buy websites.
2. **Unknown headcount.** Companies whose staff number we can't find: include them (scored lower) or exclude them from lead gen?
3. **Six starting signals.** Your list is `filing_health`, `director_change_90d`, `company_age_years`, `officer_count`, `new_charge_180d`, `accounts_category`. I'd swap `accounts_category` for **`employees_band`** (from the accounts files) where we have it, keeping `accounts_category` as the fallback. OK?
4. **PSC (who owns/controls the company).** Pull in Phase 1 (adds ~1 hour to the first load, needed for the x402 check later) or wait until Phase 4?
5. **Registered office vs trading address.** Many GM businesses register at an accountant's address elsewhere (and vice versa). Phase 1 can only use the registered office. Acceptable for now? (Phase 2 websites will give trading addresses.)
6. **Backtest honesty.** "What was known on date X" can mean (a) what the source says was true then, reconstructed from today's data (lets us backtest years back immediately), or (b) only what *we had actually recorded* by then (no hindsight, but backtests only reach back to the day we started). I propose default (a) as your prompt says, with (b) available, and backtest reports always stating which was used. Agree?
7. **Phase 0 deploy scope.** Do you want something live on Cloudflare at the end of Phase 0 (an empty API on `api.ejtech.co.uk`, D1 created), or keep everything local until the end of Phase 1?
8. **Later phases (no answer needed yet):** sending domain/inbox and warm-up plan; two launch prices for the x402 check. I'll ask again before Phase 4/5.

---

## 11. What happens after you approve

1. Create `CLAUDE.md` from sections 1–4 of your prompt.
2. Build Phase 0, run `pnpm check`, show you the output, stop at the gate.
3. On your go-ahead, build Phase 1, run the ingestion (needs your Companies House key), show gate evidence, stop.
