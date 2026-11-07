# Decision log

Newest first. Each entry: what we decided, why, and who approved it.

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
