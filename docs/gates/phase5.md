# Phase 5 gate report

Generated 2026-11-08T17:40:18.426Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| First recurring watch customer (monthly, via Stripe) with a change alert delivered | passed (synthetic) | 1 customer, 5 watches; 1 alert(s) for the simulated change (company_status: "active" → "liquidation"), delivered as a dry run |
| First recurring watch customer, live | live pending | needs Stripe keys, a real customer and the kill switch off for watch_alert |
| Human report via Stripe Checkout | passed (synthetic) | 1 task (done), revenue £9.00, report emailed (dry run); replayed webhook created no duplicate (1 task) |
| First outreach send under all guardrails (L1: approved, then sent) | passed (synthetic) | 20 drafts approved → 19 sent as dry runs, 1 blocked by guardrails (no recipient); every send has sender identity + opt-out and goes to a role-based address on the company's own domain; 0 real sends (kill switch ON by default) |
| Opt-out reply → suppression list | passed (synthetic) | info@site-10000136.example suppressed after replying "not interested" |
| Zero guardrail breaches | passed (synthetic) | 0 breaches across the run; sme_outreach last 20 tasks: success 100%, approved without edits 100% |
| First outreach send and first customer, live | live pending | needs a sending domain + provider key, and the kill switch off (docs/live-cutover.md) |

Everything external ran as a dry run: the global kill switch defaults to ON.
