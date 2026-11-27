---
type: build-report
date: 2026-11-27
status: v4 Phase 1 built and gated (synthetic data, dry-run); waiting for Archie
plan: PLAN.md
gate: docs/gates/v4-phase1.md
---

# v4 Phase 1: vault schema + source registry

**Gate: 10 of 10 passed.** `pnpm check` is green (typecheck, lint and 724 tests in 102 files). Everything ran on the
synthetic world with fake source adapters. **Nothing external happened, and nothing was deployed.**

## What's built

| Part | What it does | Where |
|---|---|---|
| Schema | Every table in PLAN.md §2, in its planned database, each migration with a down file and an up → down → up test | `packages/storage/migrations/{core/0031,core/0032,facts/0004,telemetry/0004}` |
| Rename | Phase 2's scored leads moved from `opportunities` to `lead_scores`, every row and index kept; the old API still works | core `0031` |
| Contracts | Market, region, business ID, external IDs, contacts, signals, source definitions, audit entries, problems, segments, routes, channels, opportunity rows (Zod, with tests) | `packages/contracts/src/{vault,portfolio}.ts` |
| One business ID | 1,812 of 1,812 synthetic companies got `gb-ch:<number>` and a `uk_ch` external ID, with region and industry; re-running changes nothing | `packages/verification/src/vault-backfill.ts` |
| One signals table | 4,092 engine signals and 3 scout signals copied in; scout signals are always untrusted | same |
| Problem map | The 500 seed ideas → 70 problems (6 industries × 15 functions), all "sensed" with no evidence (rule 23) | `packages/infra/src/problems.ts` |
| Source registry | 10 sources with cost, freshness, reliability, health, lane and retention; lazy connect; fetch cache; schema-drift stop; paid calls on the cost ledger | `packages/verification/src/sources/registry.ts`, `packages/config/src/sources.json` |
| Routes and channels | 5 routes, 6 channels from config; there's no AI voice or SMS channel to compile | `packages/config/src/portfolio.json` |
| Industry list | The 17 UK sectors (SIC divisions) + "all SMEs", mapped to NAICS sectors | `packages/config/src/industries.json` |

## Your amendments, where they are now

- **Limited companies only, plus the price arm:** these are opportunity-config rules, so they land in
  Phase 4 (the config spec and compiler). `businesses.company_type` is in the schema ready for them.
  PLAN.md's example config now shows both.
- **Google Places, place ID only:** done and tested. The source is `retention: id_only`, so no
  response body is ever stored; only the IDs are. Every request is a live call.
- **Cost model:** restated in PLAN.md §10 (≈ 4.1p per contacted business, LLM nodes only). The
  no-model and batch-API tests are on the Phase 3 gate, where those nodes get built.
- **Rename:** done (`lead_scores`).
- **Cockpit:** no cockpit work in Phase 1. Phase 1 adds `portfolio.problems.map()`, which the mood
  board will read.

## Where I departed from the plan (logged in `docs/decisions.md`)

1. **The old signal tables are kept, not turned into views.** `scout_signals` is in the core database
   and `signals` is in facts, and a view can't cross databases. Both old tables stay, still read by
   their code, until Phase 3 moves the readers to `signals`.
2. **Problem seeding lives in `packages/infra`.** The rule-23 guard test failed when it was in the
   verification package, because scoring code may never read the idea backlog.
3. **Fetch bodies go through the storage body helper** (inline if small, R2 if large). The guard test
   that keeps body keys inside storage caught my first version.
4. **The `paid_own_use` lane exists on sources, contacts, signals and opportunities, but not yet on
   facts.** Wiring it through the query layer and tool registry (and proving x402 refuses it) is
   guardrail work: Phase 2.

## Still assumed or unchecked

- The NAICS side of the industry list is a coarse hand mapping. It gets checked against the official
  concordance before the US pack (Phase 6).
- Google's Places caching terms, and its price: the policy pages couldn't be read from this session.
  The source stays unconnected until they're checked.
- Route stage caps in `portfolio.json` are placeholders. Each opportunity's signed config sets its own.

## Found on the way (not from this phase, not changed)

The three cockpit build reports (`brain/build-reports/cockpit-u1..u3.md`, from the merged cockpit branch)
contain the simulator's "SYNTHETIC TRADING" text. Deploys run `pnpm gen:brain`, which bundles every
`brain/` note into the Worker, so the next deploy would ship that text. `tests/simulator-isolation.test.ts`
exists to stop exactly that, but CI tests the committed bundle, which predates those reports, so CI stays
green. The fix is either rewording those reports or excluding `brain/build-reports/` from the bundle.
Your call; I haven't touched either.

## Next (Phase 2, once you approve): the guardrail layer, before any sending exists

The compliance packs (uk@1, us@1), suppression scopes, stage and opportunity caps, inboxes and
warm-up limits, the circuit breakers, the audit-log writer, the `paid_own_use` lane through the query
layer, and CODEOWNERS.

**In parallel, the sending domains still need buying** (PLAN.md §9). Warm-up is the critical path.
