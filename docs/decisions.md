# Decision log

Newest first. Each entry: what we decided, why, and who approved it.

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
