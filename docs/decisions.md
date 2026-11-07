# Decision log

Newest first. Each entry: what we decided, why, and who approved it.

## 2026-11-08 — Phase 4 decisions (review at the end)

- **⚠ Launch prices (yours to set): $0.05 cached, $0.25 premium** in USDC (`products.json`). Picked as
  low enough for agents to call freely and well above our marginal cost (~£0.0002 / ~£0.001 per call).
- **Our own small x402 v2 payment gate** over a facilitator port (shapes from `@x402/core` 2.30 types;
  headers PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE), instead of `@x402/hono`'s
  middleware. Reason: we verify → do the work → settle only on success (a failed premium re-check or
  missing data is never charged), plus our own logging and kill-switch guard. The real facilitator is
  the official `HTTPFacilitatorClient`. Alternative: the library middleware (re-evaluate at cutover).
- **Testnet first**: Base Sepolia (`eip155:84532`) with its USDC contract; mainnet (`eip155:8453`) is a
  config change after the testnet gate.
- **The live Worker only enables x402 with a REAL facilitator** (env `X402_FACILITATOR_URL` +
  `X402_PAY_TO`), and refuses payments while the kill switch is on. The fake facilitator (which accepts
  a known fake signature) is localhost-only.
- **x402 is public; the dashboard is behind Access.** Cloudflare Access on workers.dev covers the whole
  hostname, so the paid endpoint must be served on its own hostname without Access (suggest
  `check.oast-ai.com` → same Worker, route `/x402/*` only).
- **Unknown companies are free** (404 before any payment challenge).
- **Premium = live re-check from Companies House before answering**; if it fails → 503, not charged.
- **x402 request log → fact** `x402_checks_30d` (source `x402_requests`, our own log) → signal
  `x402_interest` → module `x402_discovery` (approved leads go to `sme_outreach`, pilot rules apply).
- **Blind verifier**: deterministic daily sample (hash of company/field/day), base 2%, adapting per
  source+field (more disagreement → up to 50%; none → down to 1%); re-derives from Companies House with
  only the company number and field name; disagreements → re-verification request + alert.
- **Streaming API consumer runs in the Node agent runner** (long-lived connection; Workers can't hold
  one). Events for companies in our anchor registry → re-verification requests; timepoint saved and
  resumed.

## 2026-11-08 — Phase 3 decisions (review at the end)

- **Modules start in "pilot", go "live" only with a backtest of the current note version at ≥ 3× lift.**
  Lift needs outcomes and outcomes need outreach, so pilot allows up to 50 approved leads a week
  (`infra.json` → `modules.pilot_weekly_limit`). Promotion is `promoteModule` (refuses below 3×).
  Alternative: block all outreach until a backtest exists (impossible without outcomes).
- **Your verification settles a fact.** A "human" claim's cluster always wins and the fact is verified
  (not a conflict); other sources become conflicting evidence. Resolving a conflict adds the company to
  the golden set (reason "conflict").
- **Calibration** is measured on the fact we'd have served without your claim, in confidence bands, plus
  a Brier score. Accuracy is per source+field: each source's latest claim vs your value.
- **Drift** compares each day's fetches per source+field with a 7-day baseline (volume ×0.5/×3, empty
  values +20 points, match rate −10 points, average ±50%; all config). A breach pauses that
  source+field: its facts become `quarantined` until you resume it (dashboard → Metrics).
- **Weight suggestions** need ≥ 20 closed leads and ≥ 5 positives; they're revenue-weighted (deal value)
  and blended 50/50 with the current weights (shrinkage), rounded to sum to 1. Written into the note as a
  PENDING block; only `pnpm weights accept <id>` changes the front matter (and bumps the version).
- **Nightly re-verification** priority = value (explicit request 3 > live lead 2 > other 1) × staleness ×
  uncertainty, within 2,000 API calls a night (config).
- **Backtests use today's universe membership** (known bias: companies that left the universe since
  as_of are missing) — logged in known biases.
- **Synthetic gate copies**: the Phase 3 gate writes its suggested change to a copy of the note in
  `docs/gates/phase3-outputs/`, never to `brain/frameworks/`.

## 2026-11-08 — Phase 2 decisions (review at the end)

- **⚠ Confidence floor 0.7 vs single-source website facts.** A tier-3 website fact starts at 0.75 and
  decays below 0.7 within ~5 days of fetching; tier-1 officer facts (half-life 15 days) fall below 0.7
  after ~7 days. With the 0.7 floor in `lead_gen_sme_web`, signals go neutral unless the module runs
  right after a refresh. **Kept your 0.7**; modules run on the day of the data refresh. Alternatives:
  lower the floor to 0.5, or per-signal floors (`min_input_confidence` already exists on signals).
- **Every model role uses `claude-opus-5-5`** (the Claude API guidance's default; it forbids silently
  downgrading for cost). Effort per role is set in `models.json` (low for extraction/research/
  explanations, medium for writing, high for checking). Alternative to consider at cutover: Haiku 5.5
  or Sonnet 5.5 for bulk website extraction (~40× / 2× cheaper) — your call.
- **Server-side refusal fallbacks on** (`fallbacks: "default"`) in the real Claude adapter, as the
  guidance recommends. Turn off in `packages/ports/src/anthropic.ts` if you prefer.
- **Playbook steps are orchestrated in code, with one model call per role step** (Claude Messages API
  behind `ModelClient`), rather than giving each role an autonomous Claude Agent SDK loop. The tool
  registry, checks and costs stay fully under our control and testable. The Agent SDK is reserved for
  roles that genuinely need open-ended tool use (none at L0). Alternative: Agent SDK `query()` per role.
- **The truth checker is deterministic code**, not a model: claims must cite brief facts, contain the
  fact's key value, appear in the body, and no unsupported number/date may appear. Sender identity and
  opt-out are added by code, never the model. Alternative: an extra model-based checker (can be added).
- **Expected value v1**: P(win) = base_win_rate × score ÷ 0.5 (capped), × deal value, both in the
  framework note (2%, £1,500 placeholders). Phase 3 calibrates from outcomes.
- **Unknown signals score neutral (0.5)** for every signal, not just staff size (your staff_unknown rule
  generalised). "No website found" scores as the oldest possible website.
- **Website anchoring**: a site's facts attach only if it shows this company's number, or its title
  matches the name (≥ 0.6 similarity), or its trading postcode matches; a site showing another
  company's number goes to quarantine.
- **The dashboard API records decisions; the agent runner applies them** (Workers can't run
  playbooks). Locally both run in one process, so decisions apply immediately.
- **Approved leads map to playbooks in config** (`infra.json` → `playbook_for_module`).

## 2026-11-08 — Keyless build of Phases 2–5 (Archie's change of plan)

- **Build Phases 2–5 without stopping at gates**; each phase still ends with a synthetic gate report.
  Every external system sits behind an interface ("port") with a fake; real adapters plug in at
  cutover (`docs/live-cutover.md`). The global kill switch defaults to ON (external actions off).
- **Period-dated facts don't decay** (Archie's change). Headcount, accounts category and accounts
  made-up date describe a fixed accounting period: confidence stays at the source's reliability, and
  the fact goes `stale` after its shelf life (640 days from the period end), when a newer period's
  figure is due. Alternative considered: decay from period end (made headcount confidence 0.3–0.6).
  *Interpretation note:* the full wording of this request wasn't visible in the session; this is how
  it was implemented, from the one-line summary.
- **Header-driven rate limiter** (Archie's change). Each response's `X-Ratelimit-Remain` /
  `X-Ratelimit-Reset` drive the pacing: when the remaining quota reaches the reserve (15% of the
  limit) we pause until the reset; a 429 pauses until the reset (not exponential backoff) and doesn't
  use up retries (capped at 20 pauses per request). The token bucket stays as a ceiling if headers are
  missing. Alternative: token bucket only (ignores the server's own view of the quota).
- **Companies House Streaming API in Phase 4** (Archie's change): see `docs/PLAN-phases-2-5.md`.

## 2026-11-07 — Phase 1 build decisions (for Archie's review at the gate)

- **Point-in-time answers are rebuilt from claims**, not looked up from stored fact versions. Each
  claim keeps when it was published and when we fetched it, so "what was known on date X" (and its
  confidence then) is recomputed exactly; rolled-back runs drop out automatically. Stored fact
  versions remain the audit trail of what we recorded, and when.
- **`observed_at` = when the source said it was true** (original brief); `published_at` = when it was
  knowable (Archie's rule). Facts carry `valid_from` (earliest published) and `first_observed_at`
  (renamed from `effective_from`, which mixed the two).
- **Registers keep asserting their current state.** Companies House is "continuous": a value stays
  fresh until superseded or until our last fetch, so a historical state wasn't "decaying" at the time.
- **Copies of one upstream count once and the freshest copy wins** (CH API vs CH bulk file), so a
  month-old bulk value never "conflicts" with today's API value.
- **Deterministic claim IDs**: the same source saying the same thing at the same published time gets the
  same ID; a re-fetch records an observation, not a duplicate. Ingestion is idempotent.
- **History as snapshots** (officers, PSC, charges: 6 years; filings: 3 years) — one claim per
  publication date, so backtests can see past states. Window sizes are config.
- **When a publication date can't be proved, use the fetch time** (conservative; counted per field).
- **Headcount shelf life 640 days, half-life 365 days**, measured from the accounts period end. The
  next figure arrives up to ~21 months after a period ends, so 400 days marked current figures stale.
  Consequence: headcount confidence is honest but low (≈ 0.3–0.6). Phase 2's size signal should use its
  own `min_input_confidence`; calibrate in Phase 3.
- **Conflict margin 0.15**: a disagreement is a `conflict` (review queue) unless the winning cluster's
  independent reliability beats the next by at least 0.15. Config: `verification.json`.
- **Unknown-staff companies scored neutral** is recorded in config (`unknown_policy: include_flagged`);
  the neutral scoring itself is Phase 2's signal code.
- **Phase 1 runs on synthetic data until the key is added.** A seeded generator produces bulk, ONS and
  accounts files plus fake API responses with a known right answer (`pnpm rehearse`).

## 2026-11-07 — Phase 0 build decisions

- **Worker compatibility date pinned to 2026-08-01** (not "today"). The local Cloudflare runtime used
  in tests supports dates up to August 2026; pinning means tests and production run identical
  runtime behaviour. Bump deliberately, with a test run, when needed.
- **Markdown is not touched by the formatter (Biome).** `brain/` notes are edited in Obsidian; a
  linter rewriting them would create noise and could disturb front matter.
- **SIC exclusion rule:** a company is excluded only if *all* of its SIC codes are on the exclusion
  list. A trading company that also lists a holding-company code (64209) stays in.
- **Access is checked twice:** at Cloudflare's edge (one-click Access on the workers.dev URL) and
  inside the Worker (JWT validation, fails closed if not configured). Preview/version URLs are
  disabled until Access covers them too.
- **Claims are append-only at the database level** (triggers refuse UPDATE/DELETE), not just by
  convention.
- **`effective_from` added to verified facts** alongside `valid_from`: `valid_from` = earliest
  supporting `published_at` (when knowable, used for point-in-time), `effective_from` = earliest
  `observed_at` (when it became true).

## 2026-11-07 — Phase 0–1 plan approved by Archie

- Biome, TypeScript 5.9, plain SQL migrations (no ORM), Cloudflare Containers for the agent runner,
  Companies House bulk file + ONS postcode lookup for the universe, accounts data (iXBRL) for staff
  numbers.
- Universe: active, non-dormant, 10 Greater Manchester boroughs, 5–100 staff. Exclude SIC 64209,
  68209, 74990, 99999. Keep 68310, 68320. Exclusions live in config.
- Unknown staff numbers: included, flagged `staff_unknown`, neutral on the size signal.
- Size signal: staff band where known, `accounts_category` as fallback.
- PSC (ownership) pulled in Phase 1.
- Registered office used for location in Phase 1 (logged as a known bias).
- Point-in-time: mode (a) "reconstructed" by default, using `published_at` (filing received /
  published) as the knowable date; mode (b) "strict" also available; every backtest states its mode.
- Deploy an empty health-check API behind Cloudflare Access at the end of Phase 0.
