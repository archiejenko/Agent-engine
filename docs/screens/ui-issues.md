# UI issues noticed while capturing (2026-11-09)

Listed only, not fixed. Each item names the screenshot(s) in `docs/screens/` that show it. "Phone" means
the 390px shots. Ordered by how much they get in the way; the top 5 are first.

## Top 5

1. **Every dashboard page scrolls sideways on a phone.** The header (title + 7 links) doesn't wrap, so even
   empty pages are 654px wide on a 390px screen; tables push Facts and Company to ~1,160px and Controls to
   770px. The header's underline stops at 390px while the page carries on.
   `dashboard-overview-390-light.png` (+264px), `dashboard-facts-390-light.png` (+774px),
   `dashboard-company-390-light.png` (+766px), `dashboard-controls-390-light.png` (+380px), and every other
   `dashboard-*-390-light.png` (each caption in index.html gives the overflow).
2. **The Review page is far too long to use.** It shows all 50 leads, each with its full signal table, then
   50 quarantined matches, with no paging or collapsing: 32,816px tall on desktop and 48,819px on a phone.
   The 4 drafts are at the top, but Conflicts sits below all 50 leads.
   `dashboard-review-1440-light.png`, `dashboard-review-390-light.png`.
3. **The same company can get two letters.** The pending print batch lists SYNTHETIC TRADING 68, 476, 680,
   24 and 72 again, though all five are already in the approved batch below it. Nothing on the page (or
   in the batch) warns about a company already written to. In this record it comes from separate gate runs
   approving the same companies through different opportunities, but the same could happen when two
   modules (`lead_gen_sme_web` and `x402_discovery`) pick the same company.
   `dashboard-letters-1440-light.png`.
4. **Empty states mislead or show raw errors.** With no data, Golden set says "Golden set complete (0
   companies)" (it isn't: nothing has been verified yet); a company with no data shows a raw red
   `not_found`; Facts and Metrics show bare table headers with no "nothing yet" message; Controls ends on an
   empty "Outbox (latest)" heading.
   `dashboard-golden-empty-1440-light.png`, `dashboard-company-not-found-1440-light.png`,
   `dashboard-facts-empty-1440-light.png`, `dashboard-metrics-empty-1440-light.png`,
   `dashboard-controls-empty-1440-light.png`.
5. **The kill switch line is a double negative.** "External actions are OFF (kill switch ON — everything is a
   dry run)" next to a button "Allow external actions". It's correct, but it's the one control that must be
   unmistakable. The table below also doesn't show each playbook's own kill switch: the only sign that
   `sme_letter` was switched off is a raw alert, "kill:playbook:sme_letter turned OFF".
   `dashboard-controls-1440-light.png`, `dashboard-controls-390-light.png`.

## Everything else

6. **Metrics contradicts itself.** The Alerts list says "drift companies_house.company_status paused", while
   "Paused sources (drift)" says "None." (the pause was lifted, but the alert still reads as current).
   `dashboard-metrics-1440-light.png`.
7. **Raw data instead of readable values.** JSON blobs in the Value column, cut off mid-JSON (charges,
   filing_events, officers, PSC, registered office); `in_universe_staff_unknown`-style labels on Overview;
   Review evidence shows full fact ids with ISO timestamps
   (`10000124/incorporation_date/2015-03-02T00:00:00.000Z`).
   `dashboard-facts-1440-light.png`, `dashboard-company-1440-light.png`, `dashboard-overview-1440-light.png`,
   `dashboard-review-draft-1440-light.png`.
8. **Dates wrap onto two lines** ("2026-" / "11-09") in the narrow Known from / Last verified / Expires
   columns, and the "1 claim(s)" buttons wrap too. `dashboard-facts-1440-light.png`,
   `dashboard-company-1440-light.png`.
9. **Email drafts are cramped.** The draft box is short and monospaced, so most of each email needs scrolling
   inside the box; on a phone it's narrower still. `dashboard-review-draft-1440-light.png`,
   `dashboard-review-draft-390-light.png`.
10. **Lead scoring columns wrap.** "× 0.3 = 0.300" breaks into "× 0.3 =" / "0.300", and "unknown (neutral)"
    wraps, so the sums are hard to follow. `dashboard-review-1440-light.png`.
11. **"Approve → draft email" on leads that will become letters.** Leads with no emailable address now go
    to `sme_letter`, but the button still promises an email. `dashboard-review-1440-light.png`.
12. **Letters on a phone: one word per line.** The "Addressed to" column squeezes each address into a tall
    column of single words; the batch table also scrolls sideways. `dashboard-letters-390-light.png`.
13. **Letters' demo links go nowhere yet.** They point at the placeholder host `demo.example.invalid`, and a
    pending letter's demo is 404 until the batch is approved (by design). The page doesn't say either.
    `dashboard-letters-1440-light.png`.
14. **Controls table oddities.** "Promote" shows on playbooks already at L3 (the top level); "No-edit
    approvals 0%" for automatic playbooks that never have approvals; on an empty database every playbook
    shows "Success 0%" for 0 tasks (should read "—"). `dashboard-controls-1440-light.png`,
    `dashboard-controls-empty-1440-light.png`.
15. **Controls outbox on a phone:** subjects wrap to one word per line and timestamps split in two.
    `dashboard-controls-390-light.png`.
16. **Golden set inputs look already filled.** Each box shows the current value as grey placeholder text,
    which reads like a typed answer; the buttons are small. `dashboard-golden-1440-light.png`.
17. **Conflicts list shows only one side.** "10000001 · website_url: site-10000001.example" gives the winning
    value only; you have to open the company to see what it conflicts with (the Company shot shows both
    claims). `dashboard-review-conflict-1440-light.png`, `dashboard-company-1440-light.png`.
18. **Overview only covers Phase 1.** The home page shows universe and fact counts but nothing about drafts
    waiting, the print batch, alerts, spend or revenue. `dashboard-overview-1440-light.png`.
19. **No dark mode anywhere.** The dashboard and demo pages ignore the phone's dark setting (the dark shots
    are identical to light). Readable, just not themed. `dashboard-overview-1440-dark.png`,
    `public-demo-1440-dark.png`, `public-demo-390-dark.png`.
20. **Demo homepage "Your services here" card** reads like a template placeholder to the person receiving
    the letter. `public-demo-1440-light.png`, `public-demo-390-light.png`.
21. **Bare pages on the public side.** The kill-switch-off demo URL shows a monospaced "Not found"; the
    expired, opt-out and unknown-code pages are plain one-liners with no sender name. They work, but nothing
    tells a recipient who EJTECH is. `public-demo-kill-switch-on-1440-light.png`,
    `public-demo-expired-390-light.png`, `public-opt-out-unknown-390-light.png`.
22. **Default browser buttons and inputs everywhere.** They're small and low-contrast, especially on a phone
    (Approve/Reject, Pause, Promote/Stop, Save and next). Most dashboard screenshots.

## Fine as captured

- The letter (`letter-print-batch-p1-1440-light.png`): A4 layout, window address, QR, opt-out line, footer.
- The demo homepage at both widths, apart from 19 and 20.
- The x402 challenge (`x402-payment-required-*.png`). Its `resource.url` is localhost only because it ran locally.
