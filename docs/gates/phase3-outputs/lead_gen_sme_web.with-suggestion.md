---
module: lead_gen_sme_web
version: 1
universe:
  members_of: lead_gen_sme_web_v1
  region: Greater Manchester
  headcount: [5, 100]
  status: active
lanes: [open]
confidence_floor: 0.7
signals:
  website_age_years: { weight: 0.30 }
  hiring_momentum: { weight: 0.25 }
  filing_health: { weight: 0.15, invert: true }
  director_change_90d: { weight: 0.30 }
threshold: 0.6
outcome: { event: positive_reply, window_days: 30, value_field: deal_value_gbp }
explore_share: 0.10
economics: { deal_value_gbp: 1500, base_win_rate: 0.02 }
---

# Lead gen: SME websites (Greater Manchester)

Archie's framework for finding small businesses likely to buy a new website.

- **Old or missing website** (30%): the older the site looks, the stronger the need. No website at all scores as the oldest.
- **Hiring** (25%): businesses advertising jobs are growing and spending.
- **Filing health, inverted** (15%): companies behind on filings may need help getting organised.
- **New director in the last 90 days** (30%): new people bring new budgets and fresh eyes.

Unknown signals score neutral (0.5): missing data is never a penalty.

`economics` sets expected value: P(win) = 2% × score ÷ 0.5 (capped at 100%), × £1,500 average deal.
Both are placeholders until Phase 3 measures real outcomes.

Weights change only when Archie accepts a suggested change (written below by the system).

## Suggested weight change (PENDING — not applied) <!-- ae:suggestion 3a21c104-9c84-4d56-b874-a9f6af1abcbf -->

Generated 2026-11-09 from 1528 leads whose 30-day outcome
window has closed: 239 positive, £449386 of deal value. Suggested weights blend
the current ones with the evidence (revenue-weighted). Nothing changes until you accept.

| Signal | Current | Suggested | Evidence (revenue-weighted lift) |
|---|---|---|---|
| director_change_90d | 0.30 | **0.64** | 0.730 |
| filing_health | 0.15 | **0.08** | 0.000 |
| hiring_momentum | 0.25 | **0.13** | 0.000 |
| website_age_years | 0.30 | **0.15** | 0.000 |

To accept: `pnpm weights accept 3a21c104-9c84-4d56-b874-a9f6af1abcbf` · to reject: `pnpm weights reject 3a21c104-9c84-4d56-b874-a9f6af1abcbf`
