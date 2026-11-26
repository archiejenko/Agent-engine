# Cockpit UI U1 gate report

Built on 2026-11-26 on branch `claude/cockpit-ui-plan` (rebased onto `claude/nifty-curie-91l1nq` at
`e42272e`). Synthetic data and fakes only; kill switch on; nothing deployed, nothing external happened.

| Criterion | Status | Evidence |
|---|---|---|
| `pnpm check` green (typecheck, lint, tests) | passed | 86 test files, **573 tests** (542 before U1, **31 new**, 1 extended); lint clean |
| LayoutSpec refuses an unknown component, unknown query, duplicate id, bad span; bad config falls back to the built-in layout | passed | `packages/config/src/layouts/layout.test.ts` (8 tests) |
| `/api/panels/:name` serves the 10 queries in the shared shape | passed | `apps/api/src/panels.test.ts`: every query × 6 filter combinations validated against one schema |
| Seeded holdout company never appears | passed | small fixture (holdout + ranked company, positive control) and the Phase 5 simulator world; arm/cohort fields never appear |
| Simulated rows excluded by default, labelled when included | passed | simulated company and £9 simulated spend absent by default; with `synthetic=1` labelled `simulated` and `synthetic_included: true` |
| A seeded fake key value never appears | passed | key saved through `KeyRing`; absent from all 10 panels in both modes; the guard also refuses secret-like field names and key-shaped values |
| Runway matches a hand-worked example; dry-run and simulated spend ignored | passed | £100 top-up − £10 adjustment − £21 live spend = £69; £14 ÷ 7 = £2 a day; 34.5 days; top up by 30 Dec. £1,000 dry run, £500 simulated, £300 sandbox and £50 before the first top-up all ignored. No top-up → "–" + "record a top-up in Controls" |
| `kpis` with `compare=1` returns previous-period values over a window of the same length | passed | 1–10 Nov compared with 22–31 Oct: live spend £3 vs £7, change −£4 (−57.1%) |
| Budget and cap panels never served from KV; others are | passed | second request: `x-cache: hit` for the 5 cacheable panels; no cache header and `no-store` for runway, spend_split, playbook_board, health, needs_you |
| `/api/panels/*` refused without Access | passed | every panel name (and an unknown one): 403 when Access isn't configured, without a token, and with a forged token; 200 with a valid one (`app.test.ts`) |
| Static: kit/ does no arithmetic on money fields | passed | `tests/cockpit-static.test.ts`, with a negative control proving the detector catches `+ − × ÷ +=` and `Math.*` on money |
| Static: approvals go only to `/api/decisions/:id/decide` | passed (see note) | kit/ posts nowhere else; four older pages' approval routes are listed and each checked to record through the decisions path on the server; any new route fails the test |
| `#/kit` at 390 and 1440 px, seeded and empty, zero sideways scroll | passed | `tests/mobile-layout.test.ts` now includes `#/kit` and waits for every panel to finish loading |
| Screenshots | done | `docs/screens/dashboard-kit-{390,1440}-light.png`, `docs/screens/dashboard-kit-empty-{390,1440}-light.png` |

**Bundle (gzipped JS):** before 91.05 KB (one file). After: main 92.27 KB (+1.2 KB) and a separate kit
chunk of 118.80 KB (Recharts and the kit), loaded only when `#/kit` opens. Recharts is about 115 KB of it,
a little over the plan's ~100 KB estimate.

Run again: `pnpm vitest run apps/api/src/panels.test.ts packages/config/src/layouts tests/cockpit-static.test.ts tests/mobile-layout.test.ts`.
Screenshots: `AE_SCREENS=docs/screens pnpm vitest run tests/mobile-layout.test.ts`.
