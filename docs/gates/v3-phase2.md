# Phase v3-2 gate report

Generated 2026-11-27T08:27:44.256Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Decisions from many sources appear in one list, ranked by money at stake | passed (synthetic) | 63 open decisions from 5 sources (claim_publish, lead, print_batch, draft, quarantine); ordered by money at stake |
| An expired decision takes its safe default and is never counted as an approval | failed | 62 decisions defaulted (claim_publish, lead, print_batch, draft, quarantine); owner approvals 1 → 1; the defaulted draft was cancelled with no approval-history row; the batch was rejected (nothing printed); the uncertain action stays blocked (never repeated) |
| No approval can be created except through the decisions path | passed (synthetic) | old "approve draft" button → decision decided with approval fddbf4a1; 1 owner approval(s) = 1 decision(s) Archie made; raising a tier without a decision: refused; static check: only packages/infra/src/decisions.ts creates owner approvals (tests/architecture.test.ts) |
| The queue keeps the holdout hidden | passed (synthetic) | no arm or cohort in any decision (summaries and draft context) |
| Daily digest: what happened, earned, spent and waiting | passed (synthetic) | today: 1 sent; earned £0, spent £0.63; 1 decided, 62 defaulted, 0 waiting |

Synthetic data, fakes only, kill switch on. Nothing external happened.
