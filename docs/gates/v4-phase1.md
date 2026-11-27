# Phase v4-phase1 gate report

Generated 2026-11-27T21:47:53.093Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Every v4 table from PLAN.md §2 is migrated and placed in its planned database (core / facts / telemetry); no foreign key crosses a database (placement test) | passed (synthetic) | 23 tables checked; misplaced: none. Migrations applied: core 32, facts 4, telemetry 4. Up → down → up is tested for 0032, facts 0004 and telemetry 0004 (placement.test.ts), and 0031 with its rows (v4.test.ts). |
| The old `opportunities` (Phase 2 lead scores) is renamed `lead_scores` with every row kept; its API still works | passed (synthetic) | 173 lead scores read through the old API from lead_scores; the new portfolio table is empty (no opportunity is created before Phase 4). |
| 100% of Companies House entities have a canonical business_id (gb-ch:<number>) and a uk_ch external ID; the backfill is idempotent | passed (synthetic) | 1812 entities → 1812 businesses, 1812 uk_ch IDs; unmapped 0, without an external ID 0. Second run: 1812 businesses, 0 signals copied. |
| Every engine signal (signal_values) and scout signal is in the one `signals` table, with market and lane; scout signals are untrusted | passed (synthetic) | 4092 engine signals and 3 scout signals copied; 0 left uncopied. The old tables stay until Phase 3 moves their readers. |
| The problem map is seeded from the 500 seed ideas (industry × function × category); every problem is sensed with no evidence (rule 23: seeds are guesses) | passed (synthetic) | 500 ideas → 70 problems in 6 industries × 15 functions. Problems with any evidence or a status other than sensed: 0. |
| Routes and channels come from config; there is no AI voice or SMS channel to compile (TCPA / PECR) | passed (synthetic) | service_retainer, productised_tool, x402_api, marketplace_gig, digital_product · cold_email, marketplace_listing, seo_pages, agent_directory, x_content, partnership. |
| Every source in config is registered with cost, freshness, reliability, health, lane and retention; only sources in use before v4 start connected (lazy) | passed (synthetic) | 10 registered; connected: companies_house, companies_house_accounts, companies_house_bulk, company_website, ons_postcode_directory; waiting to connect: contracts_finder, find_a_tender, google_places_us, planning_data, the_gazette. |
| A fetch hits the cache the second time | passed (synthetic) | first fetch live, second from the cache; the adapter was called 1 time(s). |
| An unregistered source is refused; a registered source is refused until it's connected for an opportunity | passed (synthetic) | unregistered → not_registered (adapter never called); the_gazette before connect → not_connected; after connect for opp_gate_example → fetched; used_by = ["opp_gate_example"]. |
| Google Places (id_only, Archie's amendment): only the place_id is stored; every other field is re-fetched on demand | passed (synthetic) | stored: ids ["ChIJ_gate"], body none; two requests → 2 live calls. Google's caching terms still to be checked before Places connects for real (Phase 6). |

Synthetic world (fake Companies House files through the normal pipeline, fake model), the real 500 seed ideas, and fake source adapters that count their calls. Nothing external happened.
