# Phase 3 gate report

Generated 2026-11-07T21:59:16.383Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Accuracy and calibration reported per source/field | passed (synthetic) | 150 golden companies; companies_house.company_status 100% (n=150), companies_house.registered_office_postcode 100% (n=150), companies_house_accounts.employees_average 79% (n=97), companies_house_bulk.company_status 100% (n=150), companies_house_bulk.registered_office_postcode 100% (n=150); 1 calibration bands; Brier 0.048; 3 sources |
| Drift monitoring pauses a source on a breach | passed (synthetic) | 42 source/field metrics today; breach on companies_house.company_status (volume 1528 vs usual 15280); 1 paused |
| Lead-gen backtest reports lift | passed (synthetic) | as of 2026-09-30, reconstructed mode, 30-day window: precision@20 45%, base rate 15.6%, lift 2.88×, revenue lift 2.50×; module stays in pilot (lift 2.88× is below the 3× needed to go live) |
| First suggested weight change written to the framework note | passed (synthetic) | written to a COPY (docs/gates/phase3-outputs/lead_gen_sme_web.with-suggestion.md) so synthetic outcomes never touch your real note; suggested director_change_90d 0.64, filing_health 0.08, hiring_momentum 0.13, website_age_years 0.15 from 1528 closed leads (239 positive) |
| Weekly digest and margin report written | passed (synthetic) | 2026-11-07-lead_gen_sme_web.md and 2026-11-07-margin.md in docs/gates/phase3-outputs |
| Same, on real data (your golden set, real replies) | live pending | needs the live Phase 1–2 data and real outreach outcomes |

Example outputs (synthetic) are in `docs/gates/phase3-outputs/`: the framework note copy with the suggested change, the module digest and the margin report.
