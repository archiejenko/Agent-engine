# Phase 5 gate report

Generated 2026-11-09T20:59:03.696Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| First recurring watch customer (monthly, via Stripe) with a change alert delivered | passed (synthetic) | 1 customer, 5 watches; 1 alert(s) for the simulated change (company_status: "active" → "liquidation"), delivered as a dry run |
| First recurring watch customer, live | live pending | needs Stripe keys, a real customer and the kill switch off for watch_alert |
| Human report via Stripe Checkout | passed (synthetic) | 1 task (done), revenue £9.00, report emailed (dry run); replayed webhook created no duplicate (1 task) |
| First outreach send under all guardrails (L1: approved, then sent) | passed (synthetic) | 20 drafts approved → 20 sent as dry runs, 0 blocked by guardrails; every send has sender identity + opt-out and goes to a role-based address on the company's own domain; 0 real sends (kill switch ON by default) |
| Leads we can't email get a letter instead (sme_letter, L0: drafts only) | passed (synthetic) | 12 unreachable leads routed to sme_letter (none sent to email as "no recipient"); each passed the same truth check and waits at the print-batch gate; 1 more lead had asked for no more letters and got none |
| Weekly print batch: print-ready PDF to The Directors with a QR to a demo; accountant addresses flagged | passed (synthetic) | batch 2026-W46-mw9qupa6: 12 letters, 12-page PDF; 1 flagged (care of Ledger & Co Chartered Accountants); Archie approved it leaving out 1 flagged letter(s); 11 tasks done (L0: Archie prints and posts) |
| Demo pages: noindex, live only after approval and with the kill switch off | passed (synthetic) | before approval 404; approved but kill switch on 404; kill switch off 200 with X-Robots-Tag "noindex, nofollow, noarchive"; left-out letter's demo 404 |
| Opt-out reply → suppression list | passed (synthetic) | info@site-10000136.example suppressed after replying "not interested" |
| Zero guardrail breaches | passed (synthetic) | 0 breaches across the run; sme_outreach last 20 tasks: success 100%, approved without edits 100% |
| First outreach send and first customer, live | live pending | needs a sending domain + provider key, and the kill switch off (docs/live-cutover.md) |

Everything external ran as a dry run: the global kill switch defaults to ON.
Sample outputs: docs/gates/phase5-outputs/print-batch.pdf (the print batch) and demo-homepage.html.
