# Phase v2-1 gate report

Generated 2026-11-16T19:28:22.547Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Every outreach intake is a cohort: ranked leads + a random holdout at the configured share | passed (synthetic) | cohort 7bd00336: 31 ranked (1 leads skipped: registered office looks like an accountant's or agent's (care of Ledger & Co Chartered Accountants); no trading address held), 5 holdout = round(31 × 0.15 / 0.85); seed recorded |
| The holdout draw is random but reproducible from its recorded seed | passed (synthetic) | seed-1 twice → the same 5 companies (10000704,10000760,10001698,10001662,10001602); seed-2 → a different 5 |
| Holdout sends pass the same compliance checks (suppression, cooldown, PECR routing, deliverable office) | passed (synthetic) | 331 companies on the suppression list; none of them in the holdout; holdout drawn only from eligible companies (email, email, email, email, email) |
| Blind review: holdout drafts are indistinguishable from ranked ones | passed (synthetic) | 25 drafts in Review, same fields for both arms, no source reference, cohort or arm in the list or in the task detail while awaiting approval |
| Outcome ledger: sent, QR scan, demo visit (with time on page), reply and paid, each attributed to its task, arm and playbook version | passed (synthetic) | 25 email sends + 11 letters (all dry run); QR scan 200 with 42000 ms on page; 2 demo visits; reply → task a11b2ab1 (ranked); paid £1500 → task a11b2ab1; 41 pre-payment events carry an estimated £ value with its assumption |
| Demo pages: no cookies, IP or device details; one hashed script; privacy line shown | passed (synthetic) | CSP: default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'sha256-tQl5AtyfP8E7QgIwBQLCPquqFX7TJ1051dQz6gfXEHY='; connect-src 'self' |
| Synthetic data never trains anything; reports show it only when asked, labelled | passed (synthetic) | 36 tasks and 42 ledger rows, all synthetic; P(paid) still on priors (0.0045, evidence {"sent":0,"reply":0,"paid":0}); real lift report: 0 cohorts; simulated lift report labelled "SIMULATED (synthetic rows included)" |
| Lift is measured on assignment (intent to treat), with a 95% interval; no claim without paid outcomes | passed (synthetic) | sent 31/31 vs 5/5; qr_scan 1/31 vs 0/5; demo_visit 2/31 vs 0/5; reply 1/31 vs 0/5; reply_positive 1/31 vs 0/5; booking 0/31 vs 0/5; paid 1/31 vs 0/5 |
| Unit economics per playbook: model cost, send cost, revenue, margin and Archie's minutes | passed (synthetic) | sme_letter: send £10.89, revenue £0.00, 2 min; sme_outreach: send £0.00, revenue £0.00, 18.8 min |

Run by the simulator in a sandbox database: every row is synthetic = 1 and is excluded from learning.
Everything external ran as a dry run: the global kill switch defaults to ON (switched off only to serve demo pages, then back on).
