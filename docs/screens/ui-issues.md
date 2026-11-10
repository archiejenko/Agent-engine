# UI issues (re-captured 2026-11-09, after the screenshot-review fixes)

64 screenshots, 1440px and 390px. **Every page now has zero sideways scroll** at both widths (measured on
each capture, and enforced by `tests/mobile-layout.test.ts` for seeded and empty data). Listed only;
the open items below are not fixed.

## Resolved since the first record

| # (first record) | Issue | Now | Shown in |
|---|---|---|---|
| 1 | Every page scrolled sideways on a phone (264–774px) | Nav wraps; tables become stacked cards under 600px; 0px on all 64 shots | every `*-390-light.png` |
| 2 | Review was 32,800px tall | Tabs (Drafts / Leads / Conflicts / Quarantine), 20 per page, score breakdowns collapsed | `dashboard-review-*.png` |
| 3 | Same company could get two letters | 90-day per-company cooldown across email and letters; blocked duplicates listed on Letters | `dashboard-letters-1440-light.png` |
| 4 | Misleading empty states | Golden set, Company not found, Facts, Metrics, Controls and Letters all say what's missing | `dashboard-*-empty-*.png`, `dashboard-company-not-found-*.png` |
| 5 | Kill-switch double negative | One banner: "Sending: OFF, dry run" / "Sending: LIVE"; each playbook's own switch in the table | `dashboard-controls-*.png` |
| 6 | Metrics: alert said "paused" while Paused sources said none | Resuming a source closes its drift alert | `dashboard-metrics-1440-light.png` |
| 7 | Raw JSON and raw field names | Readable labels; officers, PSCs, filings, charges as short lists | `dashboard-facts-*.png`, `dashboard-company-*.png` |
| 8 | Dates wrapped onto two lines | Dates and claim buttons no longer wrap | `dashboard-company-1440-light.png` |
| 9 | Cramped monospace draft box | Taller box in the normal font; evidence shown as "Incorporated (as of 2015-03-02)" | `dashboard-review-drafts-*.png` |
| 10 | Lead score columns wrapped | Breakdown is a labelled, collapsed table | `dashboard-review-leads-expanded-1440-light.png` |
| 11 | "Approve → draft email" on letter leads | "Approve → email" or "Approve → letter"; x402_discovery is read-only | `dashboard-review-leads-*.png` |
| 14 | Promote on L3, 0% for no tasks | Promote hidden at L3; "n/a (automatic)"; "—" with no tasks | `dashboard-controls-*.png` |
| 12, 15 | One word per line in Letters / Controls tables on a phone | Rows are now cards with labelled lines | `dashboard-letters-390-light.png`, `dashboard-controls-390-light.png` |
| 16 | Golden inputs looked pre-filled | Separate "What we hold" column; inputs start empty | `dashboard-golden-*.png` |
| — | (new) Print and postage missing from margins | £0.99 per approved letter (placeholder) in task cost and margins; shown per batch | `dashboard-metrics-1440-light.png`, `dashboard-letters-1440-light.png` |
| 20 | "Your services here" demo card | Cards written for the company's sector from its SIC code | `public-demo-*.png` |
| 21 | Bare public pages with no sender | Expired / opt-out / not-found pages carry the full trading disclosure | `public-*.png` |
| 22 | Tiny default buttons | Larger buttons; primary actions highlighted | most dashboard shots |

## Fixed after this capture (2026-11-10, not yet in the screenshots)

- Open #2: the Leads tab disables "Approve" for companies in cooldown and says "Contacted [date],
  cooldown until [date]" (or what's pending).
- Open #4: blocked duplicates are one digest alert per day ("7 duplicates blocked today").
- Open #10: Overview starts with a "Today" panel: drafts waiting, letters awaiting batch approval,
  open conflicts, alerts, and 7-day revenue / cost / margin; the data section follows it.

## Still open

1. **Cards make long pages on a phone.** Facts shows 50 facts as 50 seven-line cards, and the Company
   page one card per fact; Overview's two-column count tables also become verbose "Decision / Count"
   cards. No sideways scroll, but a lot of scrolling. `dashboard-facts-390-light.png`,
   `dashboard-company-390-light.png`, `dashboard-overview-390-light.png`.
2. **Leads list companies that are already in cooldown.** The Leads tab still offers "Approve → letter"
   for companies the cooldown will block: the approval is accepted, then the cooldown stops the task
   and lists it under "duplicates blocked" on Letters. Better: mark or hide them in the queue. `dashboard-review-leads-1440-light.png`.
3. **The read-only x402_discovery block comes first in each lead card**, above the actionable
   lead_gen_sme_web block, so the button is lower than it needs to be.
   `dashboard-review-leads-1440-light.png`, `dashboard-review-leads-390-light.png`.
4. **Alerts are noisy.** Each blocked duplicate is an alert, so Metrics and Controls list several
   "contact blocked" lines above the alerts that matter. `dashboard-metrics-1440-light.png`,
   `dashboard-controls-1440-light.png`.
5. **Fake-writer copy repeats itself** ("brings in better enquiries … websites that bring in
   enquiries"). It's the deterministic stand-in for the model, but the copy rules don't catch repeated
   phrases. `dashboard-review-drafts-1440-light.png`, `letter-print-batch-p1-1440-light.png`.
6. **Golden set on a phone:** the "What we hold" value and its confidence wrap awkwardly side by side
   ("WN5 / 5FL (confidence / 0.95)"). `dashboard-golden-390-light.png`.
7. **Letters' company column wraps to three lines** at desktop width (long synthetic names).
   `dashboard-letters-1440-light.png`.
8. **Placeholders are visible on outbound pages:** company number 00000000, "Registered office
   placeholder" and `demo.example.invalid`. Intended until cutover (Letters shows "Don't print yet",
   and real sends refuse to run), but they appear in every letter and demo footer.
   `letter-print-batch-p1-*.png`, `public-*.png`.
9. **Conflicts still show one side only.** You open the company page to see what disagrees.
   `dashboard-review-conflicts-1440-light.png`.
10. **Overview still covers Phase 1 only** (universe and fact counts): nothing on drafts waiting, the
    print batch, alerts, spend or revenue. `dashboard-overview-1440-light.png`.
11. **No dark mode.** Unchanged: the dark shots match light. `dashboard-overview-1440-dark.png`,
    `public-demo-*-dark.png`.
