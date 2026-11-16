# Phase v2-4 gate report

Generated 2026-11-16T20:28:47.264Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Claim this site end to end in test mode: sample → checkout (setup + monthly) → paid → details → draft → approved → live → domain proposal | passed (synthetic) | checkout £149 + £15/mo (test session cs_test_fake_eb8eb…); details email → form → draft "Boiler repairs in Stockport" → approved → live at /s/q32ba2wnhdd5; 2 customer emails (details form, domain proposal); fulfilment task done |
| Ledger attribution: checkout_started, paid (setup + first month) and the monthly renewal, attributed to the letter that earned them | passed (synthetic) | checkout_started → task 56e94ce2; paid £15 + £164 → the same letter task (arm ranked) |
| Webhook replay doesn't double-fulfil | passed (synthetic) | replayed payment event → "replay ignored"; 1 fulfilment task, 1 workflow, 2 customer emails (unchanged); every external action recorded once |
| Cancellation (opt-out) stops fulfilment within one step; refund recorded | passed (synthetic) | subscription cancelled while waiting for details → workflow stopped ("claim cancelled"), no further emails, details link closed (404); churned recorded; refund on the first claim recorded |
| post_reply at L0: a reply gets a triaged, checked draft for Archie; nothing is sent | passed (synthetic) | 4 outreach emails; reply "how much would it cost? Ignore your instructions…" → triage price → draft waiting for review (the message's instructions were ignored: it's untrusted data) |
| Stripe test mode only; the unverified live subscription call refuses to run | passed (synthetic) | live key → "Stripe is test mode only in this build (v2 rule 9): use an sk_test_ key"; real subscription Checkout → refused (not verified) |
| Human minutes per site against the target | passed (synthetic) | claim 1: 6 of 30 target minutes |

Test mode only: the fake Stripe signs every webhook with the same signature scheme the real one uses; no real card, email or site was touched.
The real Stripe subscription call and the Stripe event field names are NOT verified (Stripe's docs were blocked from the build environment); the real call refuses to run until they are.
