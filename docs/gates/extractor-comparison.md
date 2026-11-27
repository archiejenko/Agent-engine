# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

Run 2026-11-27T19:59:30.561Z on 20 synthetic-world fixture sites (3 pages each, cut by the
per-page budget), with the extractor's real prompt and JSON schema. No real cached pages exist in the
repo. Prices: models.json (price table 2026-11-27), USD→GBP 0.79.

| Model | Fields right | Wrong | Missing | Extra (not asked / injected) | Errors | Invalid JSON | Avg cost a call | Avg tokens in / out | Avg latency |
|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 100.0% (70/70) | 0 | 0 | 0 | 0 | 0 | £0.0068 | 1339 / 164 | 2335 ms (p90 2926 ms) |
| gemini-4-hydrogen | 98.6% (69/70) | 1 | 0 | 0 | 0 | 0 | £0.0041 | 1056 / 482 | 2806 ms (p90 4555 ms) |

Field-level agreement between the two models: 98.6% (69/70 fields either returned).

Wrong values, Opus: none

Wrong values, Hydrogen: 10031676 job_postings: ["Junior Developer"] (expected ["Sales Executive","Junior Developer"])
