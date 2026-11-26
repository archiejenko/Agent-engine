# Phase v2-3 gate report

Generated 2026-11-26T20:25:24.618Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| 50 parallel reservations can't exceed a cap | passed (synthetic) | playbook cap £5: 50 parallel £0.25 reservations → 20 granted (£5.00), 30 refused, queue paused + alert; settling at the real cost freed room again; raw ledger: 50 parallel 1p against 25p → 25 granted |
| S-tier increases need Archie's recorded approval (lowering doesn't) | passed (synthetic) | without approval: refused; made-up approval: refused; approved on the dashboard → S2; same approval reused for S3: refused; lowered to S0 with no approval |
| L3 autonomy needs Archie's recorded approval | passed (synthetic) | promotion L2 → L3 without approval: "can't promote sme_outreach to L3: needs Archie's recorded approval"; level stays L2 |
| Experiment spend stays within the weekly explore share; normal work still runs | passed (synthetic) | explore share 10% of £140.00/week = £14.00; 60 experiment steps of £0.40 asked (playbook raised to S3 so the share is the limit) → £14.00 spent, 25 refused; a normal step still got budget; dashboard shows £14.00 of £14.00 |
| The runner reserves before every step and settles at the real cost | passed (synthetic) | one sme_outreach task run by the runner (now awaiting_approval): 5 model/tool steps → 5 reservations, all settled at the real cost (£0.0000 of £0.25 held, £0.0017 of £0.25 held, £0.0000 of £0.25 held, £0.0018 of £0.25 held, £0.0000 of £0.25 held) |

The budget ledger here is the same code the Budget Durable Object runs, behind an in-process lock; on Cloudflare the Durable Object's one-call-at-a-time execution gives the same guarantee.
