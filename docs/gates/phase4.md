# Phase 4 gate report

Generated 2026-11-09T22:03:29.149Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| End-to-end paid call (402 → pay → data with per-field confidence and last_verified_at) | passed (synthetic) | fake facilitator (dry run); 252 payments settled to the fake ledger |
| End-to-end paid call on testnet (Base Sepolia, real facilitator) | live pending | needs facilitator URL, wallet address and a funded testnet agent wallet (docs/live-cutover.md) |
| Licensed facts can't be served | passed (synthetic) | planted a licensed claim on 10000001; response excluded it; x402/human_check asking for licensed is refused by the query layer (tested) |
| Median response time and margin per call reported | passed (synthetic) | cached: 202 calls, median 2 ms, price £0.0395, margin £0.0393/call; premium (live re-check): 50 calls, median 12 ms, margin £0.1965/call (local SQLite + fake Companies House; real latency will be higher) |
| Blind verifier and adaptive re-verification | passed (synthetic) | 50 companies, 57 facts re-derived blind, 0 disagreements |
| Companies House Streaming API consumer | passed (synthetic) | 30 events → 30 re-verification requests; resumes from timepoint 129 |
| Request log feeds the x402_discovery module | passed (synthetic) | 1023 companies scored, 261 opportunities |

Prices are placeholders ($0.05 cached, $0.25 premium) until Archie sets them (packages/config/src/products.json).
