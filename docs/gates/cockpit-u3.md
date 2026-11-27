# Cockpit UI U3 gate report

Built on 2026-11-27 on branch `claude/cockpit-ui-plan`, on top of U2 (`303962a`). Synthetic data and
fakes only; kill switch on; nothing deployed, nothing external happened. Not merged.

| Criterion | Status | Evidence |
|---|---|---|
| `pnpm check` green | passed | 93 test files, **628 tests** (590 at U2; 38 new); lint and typecheck clean |
| Phone layout on every page at 390 and 1440 px, seeded and empty | passed | `tests/mobile-layout.test.ts`: every page and tab, including Home's tabs and `#/kit`: zero sideways scroll |
| Forced failure on one panel per page that uses panels | passed | Ideas (`ideas_board`), Board (`board_heatmap`), CRM (`crm_pipeline`), Inbox (`inbox_strip`), Controls (`runway`), Vault (`vault_learned`), Home (`kpis`): the failing panel shows its error; everything else on the page renders |
| Static approvals test with an empty allow-list | passed | `tests/cockpit-static.test.ts`: every dashboard write is `/api/decisions/:id/decide` or a listed non-approval (settings, notes, imports, acks, lowering a tier, `/api/decisions/request`); the four older routes are no longer called |
| The four older buttons use `/decide` | passed | Budgets, Controls promote, Board pin/kill, Letters batch; `apps/api/src/decisions-request.test.ts` shows a request approves nothing until `/decide` |
| Simulator/rehearsal loaders can't write to production D1 | passed | `tests/simulator-isolation.test.ts` (9 checks): no generator, gate or loader in the Worker bundle (wrangler metafile); loaders open only local SQLite, never D1, the Cloudflare API, `wrangler d1`/`--remote` or a production database name; D1 storage is created only in the Worker entry |
| Test-world leads marked simulated (test data only) | passed | with Include simulated off, Needs you holds no lead from the test world; on, they're labelled simulated |
| Leaderboard: active only + Show all (N); phone cards | passed | panel test (`all=1`), browser test (cards at 390, table at 1440) |
| Runway → Controls top-up form | passed | browser test clicks the link and lands on the form |
| Low-runway decision | passed | `packages/infra/src/__tests__/low-runway.test.ts` (7): threshold from config, one decision, never repeated, new episode after a top-up, none at/above threshold, missed deadline pauses the queue as "defaulted" with no approval; top-up recorded only by `/decide` |
| Compact Needs-you rows | passed | `kit.test.ts`: one line, details closed until clicked; read-first types link instead |
| Page panels behind `toPanelResult` | passed | the five new queries are in the registry and pass the shared shape, holdout, simulated and key-leak tests; `panels-pages.test.ts` checks their numbers |
| Before/after screenshots of every changed page | done | `docs/screens/dashboard-<page>-before-*.png` and `dashboard-<page>-*.png` for Home, Ideas, Board, CRM, Inbox, Controls, Vault and the kit (390 and 1440, seeded and empty) |

**Bundle (gzipped JS):** main 93.08 KB (U2: 92.30); the shared kit and chart chunk 117.29 KB, loaded
only on pages with panels.

## Ready to merge

- [x] `pnpm check` green at the commit (628 tests).
- [x] Every page passes the phone layout test, seeded and empty.
- [x] No approval path other than `/api/decisions/:id/decide`; no allow-list.
- [x] No new tables or migrations (the low-runway threshold is config; `decisions.markSynthetic` sets an
      existing column, test world only).
- [x] Simulator and rehearsal code proved absent from the Worker bundle.
- [x] Nothing deployed; kill switch defaults unchanged; holdout blind everywhere.
- [ ] Archie reviews the screenshots and the open questions in `brain/build-reports/cockpit-u3.md`.
- [ ] Merge into `claude/nifty-curie-91l1nq` (Archie's call), then the GitHub Deploy workflow deploys.
