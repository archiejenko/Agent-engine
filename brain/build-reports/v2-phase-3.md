---
type: build-report
phase: v2-3
date: 2026-11-16
status: gate passed (synthetic + Worker build)
---

# v2 Phase 3: hard budgets (gate report)

## In one paragraph

Spend caps used to be checked against the run log **after** money was spent, so several jobs running at
once could each see room and together go over. Now every model step **reserves** money first, in one
Budget Durable Object, and settles at the real cost afterwards (or releases the reservation if the step
fails). The Durable Object handles one request at a time, so 50 jobs asking at the same moment can't
overspend a cap. Each playbook has a **spend tier** (S0 to S3):
- you can lower a tier with one click;
- raising one records your approval first, and nothing else can raise it;
- **L3 autonomy** now needs the same recorded approval.

**Exploratory work** (experiments and explore-flagged leads) is capped at **10% of the week's budget**,
so it can't crowd out normal work.

## What was built

| Part | Where |
|---|---|
| Budget ledger (reserve / settle / release, all-or-nothing across scopes) | `packages/infra/src/budget.ts` → `BudgetBook` |
| Budget Durable Object (SQLite-backed, synchronous KV) | `apps/api/src/runtime-worker.ts` → `BudgetObject`, binding `BUDGET` |
| Local equivalent (same ledger behind an in-process lock) | `LocalBudgetPort` |
| Runner integration: each step holds min(£0.25, what the task has left), then settles | `packages/infra/src/runner.ts` |
| Scopes: task budget · playbook daily cap (by tier) · global daily cap · weekly explore share | `scopesFor` |
| Spend tiers S0–S3 + owner approvals (single-use, who/when recorded) | `setSpendTier`, table `owner_approvals` (migration 0012) |
| L3 needs a recorded approval | `promotePlaybook` |
| Reporting | table `budget_events`, `/api/budgets`, Controls → Budgets (tier selector) |
| Rule 14 checks | `tests/architecture.test.ts`: agent-facing code can't touch switches, caps, tiers, autonomy or approvals; approvals are created only by the dashboard API |

When a reservation is refused it works like a cap being hit:
- the queue pauses (unless only the task's own budget is full);
- you get an alert;
- the step stops.

A step that costs more than it reserved is recorded at the real cost, and raises a "budget overrun"
alert.

## Gate (docs/gates/v2-phase3.md): `pnpm gate:v2-phase3`

| Criterion | Status | Evidence |
|---|---|---|
| 50 parallel reservations can't exceed a cap | passed (synthetic) | £5 cap, 50 × £0.25 at once → exactly 20 granted, 30 refused, queue paused + alert |
| S-tier increases need your recorded approval (lowering doesn't) | passed (synthetic) | no approval, made-up approval and reused approval all refused; dashboard approval → raised; lowering free |
| L3 autonomy needs your recorded approval | passed (synthetic) | L2 → L3 refused without it |
| Experiment spend stays within the weekly explore share | passed (synthetic) | £14.00 share: £14.00 spent, then refused; normal work still got budget |
| The runner reserves before every step and settles at the real cost | passed (synthetic) | 5 steps → 5 reservations, all settled |

The Worker also builds with the new `BUDGET` Durable Object (`wrangler deploy --dry-run`).

**Tests:** `pnpm check` is green: 367 tests in 44 files.

**A gate weakness I fixed while writing it:** the first version of the explore check passed only because
the playbook's own daily cap ran out first. The explore share was never actually tested. The gate now
raises that playbook to S3 (through the approval path) so the explore share is the real limit.

## Config values that need real numbers

| Config (`infra.json` → `caps`) | Now | Meaning |
|---|---|---|
| `global_per_day_gbp` | 20 | everything, per day (unchanged) |
| `per_playbook_per_day_gbp` | 5 | the S0 cap per playbook (unchanged) |
| `spend_tiers` | S1 £10 · S2 £25 · S3 £60 | daily cap per playbook at each tier |
| `explore_share` | 0.10 | experiments' share of the weekly budget (global × 7) |
| `step_reservation_gbp` | 0.25 | held back before each step (assumption; real steps cost well under 1p with the fake model) |

## Notes

- Printing and postage still don't count against the daily caps (you approve those per batch). They do
  count in task cost and margins. Unchanged from before.
- The old after-the-fact cap check is still there as a second line of defence.

Next: Phase 4 (claim-this-site checkout, fulfilment workflow, post-reply playbook).
