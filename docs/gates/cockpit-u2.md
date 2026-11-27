# Cockpit UI U2 gate report

Built on 2026-11-27 on branch `claude/cockpit-ui-plan`, on top of U1 (`c23f3a5`). Synthetic data and
fakes only; kill switch on; nothing deployed, nothing external happened.

| Criterion | Status | Evidence |
|---|---|---|
| `pnpm check` green | passed | 89 test files, **590 tests** (573 at U1; 17 new); lint and typecheck clean |
| Home built from `home.json` in the plan §4 order | passed | filter bar and live/simulated badge, brief, two KPI rows (plus Runway), Needs you, revenue vs spend and small multiples, live runs beside the pipeline, leaderboard, spend split, health |
| Mobile layout test on Home at 390 and 1440 px, seeded and empty | passed | `tests/mobile-layout.test.ts`: zero sideways scroll on Home and its two new tabs (`#/?tab=queue`, `#/?tab=quality`), every other page unchanged |
| One panel query forced to fail; every other Home panel still renders | passed | `kpis` answers 500 in the browser: the two KPI panels show the error, every other panel in `home.json` renders; Retry recovers |
| Needs you: top 5, open count, "See all (N)", buttons only to `/api/decisions/:id/decide` | passed | browser test clicks "Skip": exactly one approval request, to `/api/decisions/:id/decide`; the count drops by one; See all opens `#/?tab=queue`. Static test from U1 still passes |
| Old sections kept on a Quality tab | passed | All figures (every old tile), daily digest, "Data and today", "Quality, lift and unit economics" |
| Filters in the URL hash; defaults 30 days, live only, compare on | passed | `filters.ts`; Home's tab is kept when a filter changes |
| Holdout: blind, not drop | passed | a seeded holdout company's draft **is** in `needs_you`, with exactly the same fields as a ranked one; no panel result has an arm, cohort or holdout field at any depth (small fixture and the Phase 5 world) |
| `needs_you` respects the simulated switch | passed (see open question 1) | a company drawn only into a simulated cohort: left out by default, labelled "simulated" when included; the open count changes by one |
| Compare windows share no day | passed | events at 00:00:00.000 on 1 Nov and 23:59:59.999 on 31 Oct each count once, in their own window; `unitEconomics` with `until` leaves out a task created at the end instant |
| Funnel divider; no badge on "–" | passed | `apps/dashboard/src/kit/kit.test.ts` |
| `home.json` checked at build time | passed | `apps/dashboard/src/kit/layout.test.ts` (bad file stops the plugin, plugin is wired into Vite); confirmed by hand: a broken file makes `pnpm build:dashboard` exit 1 naming the problem |
| Before and after screenshots | done | `docs/screens/dashboard-home-before-*.png`, `docs/screens/dashboard-home-after-*.png` (390 and 1440, seeded and empty) |

**Bundle (gzipped JS):** main 92.30 KB (U1: 92.27). Charts and kit in one shared chunk of 116.32 KB, plus
the cockpit 1.65 KB and the kit page 3.32 KB. Home starts fetching the chart chunk when it mounts.

Run again: `pnpm vitest run apps/api/src/panels.test.ts apps/dashboard/src/kit tests/mobile-layout.test.ts`.
Screenshots: `AE_SCREENS=docs/screens AE_SCREENS_TAG=after pnpm vitest run tests/mobile-layout.test.ts`.
