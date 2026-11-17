---
type: build-report
phase: v3-1
date: 2026-11-17
status: gate passed (synthetic)
---

# v3 Phase 1 — shell, Home and CRM (gate report)

## What changed

**The navigation now has seven pages:** Home, Ideas, Board, Vault, CRM, Inbox, Controls. Old links redirect to wherever their
content moved (`#/review` → Inbox, `#/letters` → Inbox → Letters, `#/facts` → CRM → Facts, `#/golden` →
CRM → Verify, `#/metrics` and `#/overview` → Home, `#/company/<number>` → CRM company view). Ideas and
Board are placeholders until Milestone D; Vault arrives in Phase 4.

**Home** (`/api/home`) shows the following, each read from the outcome ledger:
- revenue;
- monthly recurring revenue;
- pipeline value;
- sends and reply rate;
- sales;
- cost to acquire a customer and cost to serve;
- margin;
- ranked-versus-holdout lift with its 95% range;
- your review minutes.

**Every tile is labelled** as one of:

| Label | Meaning |
|---|---|
| real | comes from actual events |
| estimated | comes from the conversion model |
| assumed | rests on a placeholder, e.g. the £40/hour rate |
| dry run | the sends were simulated |
| SIMULATED | simulator rows are included |

There are filters for the date range, the playbook, and whether to include simulated rows. The old Overview
and Metrics sit below the tiles as folded sections.

**CRM** (`/api/crm`, `/api/crm/:id`, `/api/crm.csv`) has one row per company that we've touched or that has a
live lead. Each row shows:
- **stage**: new, contacted, engaged, replied, claimed, customer, lost or opted out;
- expected value (real for customers, estimated for leads);
- last contact;
- next step;
- the agent that owns it.

You can search, filter by stage and export a CSV. The company view shows every contact (emails and letters),
every ledger event, the claimed site, the work done, opt-out status and the verified facts. The Facts browser
and the verification golden set now live here as tabs (Facts, Verify).

There is **no CRM table**: the stage is always derived from the ledger, letters, claims, suppressions, leads
and open tasks, so it can't drift from the records.

**The holdout stays hidden** (rule 22). There is now one shared "blind" serializer (`packages/infra/src/blind.ts`). It's used by Review, the CRM and
the task view. It drops the arm and cohort from ledger rows and tasks.

## Gate (`pnpm gate:v3 --phase 1`, docs/gates/v3-phase1.md)

| Criterion | Status |
|---|---|
| All seven routes are in the navigation and render at phone and desktop width | passed (synthetic) |
| Home figures reconcile to the ledger (revenue = paid − refunded, sends, sales) and every tile is labelled | passed (synthetic) |
| The CRM shows a full history for a fixture company (letter → claim → paid → renewal → refund) | passed (synthetic) |
| No company, task or message view reveals the holdout arm | passed (synthetic) |

The phone-layout test (`tests/mobile-layout.test.ts`) now covers every page and tab at 390 px and 1440 px, with
and without data. It also fails if a navigation page is ever left out. `pnpm check` is green: 376 tests in
47 files.

## Config

- `infra.json` → `owner.hourly_gbp` = **40**, marked as an assumption (decision D2). Set it, then set
  `hourly_is_assumption` to false.

Next: Phase 2, the Needs-you queue.
