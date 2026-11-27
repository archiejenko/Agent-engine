# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

> **Opus did not run.** All 20 Claude calls were refused by the Anthropic API before reaching the model:
> `output_config.format.schema: Empty schema ({}) that accepts any JSON value is not supported.` The
> extractor schema leaves each fact's `value` as `{}`, which Gemini accepts and Claude does not. The Opus
> row's 0% is 20 request errors, not a measured result. Fix pending Archie's approval, then re-run.

Run 2026-11-27T17:18:33.877Z on 20 synthetic-world fixture sites (3 pages each, cut by the
per-page budget), with the extractor's real prompt and JSON schema. No real cached pages exist in the
repo. Prices: models.json (price table 2026-11-27), USD→GBP 0.79.

| Model | Fields right | Wrong | Missing | Extra (not asked / injected) | Errors | Invalid JSON | Avg cost a call | Avg tokens in / out | Avg latency |
|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | 0.0% (0/70) | 0 | 70 | 0 | 20 | 0 | £0.0000 | 0 / 0 | 0 ms (p90 0 ms) |
| gemini-4-hydrogen | 97.1% (68/70) | 2 | 0 | 0 | 0 | 0 | £0.0040 | 709 / 541 | 3325 ms (p90 5785 ms) |

Field-level agreement between the two models: 0.0% (0/70 fields either returned).

Wrong values, Opus: none

Wrong values, Hydrogen: 10071271 job_postings: ["Chef de Partie"] (expected ["Electrician","Chef de Partie"]); 10174218 job_postings: ["Sales Executive"] (expected ["Office Manager","Sales Executive"])
