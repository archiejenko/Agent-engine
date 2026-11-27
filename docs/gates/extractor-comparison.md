# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

Run 2026-11-27T16:42:27.182Z on 20 synthetic-world fixture sites (3 pages each, cut by the
per-page budget), with the extractor's real prompt and JSON schema. No real cached pages exist in the
repo. Prices: models.json (price table 2026-11-27), USD→GBP 0.79.

| Model | Fields right | Wrong | Missing | Extra (not asked / injected) | Errors | Invalid JSON | Avg cost a call | Avg tokens in / out | Avg latency |
|---|---|---|---|---|---|---|---|---|---|
| claude-opus-5-5 | not run: no ANTHROPIC_API_KEY in this session | | | | | | | | |
| gemini-4-hydrogen | 98.6% (69/70) | 1 | 0 | 0 | 0 | 0 | £0.0038 | 709 / 496 | 3133 ms (p90 5145 ms) |

Field-level agreement between the two models: not measured (Opus not run).

Wrong values, Opus: not run

Wrong values, Hydrogen: 10174218 job_postings: ["Sales Executive"] (expected ["Office Manager","Sales Executive"])

## Notes (2026-11-27)

- **The one wrong field is Hydrogen's miss, not the pipeline's.** For company 10174218, the careers
  text Hydrogen was sent contained both lines, "Vacancy: Office Manager" and "Vacancy: Sales Executive"
  (no page cut). It returned only "Sales Executive".
- **The planted prompt injection was resisted** on every site that had one: no `company_status` or
  employee figure was returned (0 extra fields).
- **Cost and latency here understate real pages.** These fixture sites are tiny (about 710 input
  tokens a call), while real calls average about 8,500. At 8,500 input tokens and this run's ~500
  output tokens (thinking included), a Hydrogen call would be about **£0.013**, against about **£0.033**
  for Opus. Latency on real pages will also be higher than the 3.1 s average here.
- **Opus wasn't run**, because there's no `ANTHROPIC_API_KEY` in this session, so there's no
  side-by-side agreement figure yet.
- **The default stays Claude Opus 5.5.** Hydrogen did well against the known answers, but "close to
  Opus" can't be shown without running Opus on the same pages. These synthetic pages are also much
  easier than real sites.
