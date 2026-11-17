# Phase v3-1 gate report

Generated 2026-11-17T20:12:36.113Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| All seven routes are in the navigation and render (phone and desktop: tests/mobile-layout.test.ts) | passed (synthetic) | navigation: Home, Ideas, Board, Vault, CRM, Inbox, Controls; old links (#/review, #/letters, #/facts, #/metrics, #/golden, #/company/…) redirect to their new place |
| Home figures reconcile to the ledger, and every tile says what kind of number it is | passed (synthetic) | revenue £194 = paid − refunded in the ledger (£194); sends 13 = 13 sent rows; sales 2 = 2 paying companies; with simulated rows off, sends = 0; labels: synthetic |
| The CRM shows a full history for a fixture company | passed (synthetic) | 10000068: stage lost; 1 contact(s), ledger refunded, paid, checkout_started, demo_visit, sent, 1 claim, 2 task(s); list 63 companies (new 50, contacted 10, replied 1, lost 2); CSV export matches |
| No company, task or message view reveals the holdout arm | passed (synthetic) | 5 views checked (CRM list, CSV, Review, 2 holdout companies and their waiting drafts): 0 mention an arm or cohort |

Synthetic data, fakes only, kill switch on. Nothing external happened.
