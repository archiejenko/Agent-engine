# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

**Not run yet (2026-11-27).** The comparison needs real calls to both providers, and this cloud session
has neither key: `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` are not set, and the secure key form can only
save keys sent as `Authorization: Bearer` (Gemini reads `x-goog-api-key`, Claude reads `x-api-key`).
No results are estimated or made up here.

**To run it** (about £1 for 20 pages, both models together):

```bash
# in .dev.vars on the laptop (or as environment variables):
#   ANTHROPIC_API_KEY=...   GEMINI_API_KEY=...
pnpm compare:extractors --pages 20
```

It sends the synthetic-world fixture sites (3 pages each, cut by the per-page budget) through both
models with the extractor's real prompt and schema. It scores every field against the fixtures' known
answers (company number, trading postcode, role email, job postings), counts wrong, missing and extra
fields (including the planted prompt injection) and checks agreement between the models. It also reports
average cost per call and latency, and overwrites this file with the results. There are no real cached
pages in the repo to add.

**Until it has been run, the extractor stays on Claude Opus 5.5** (`models.json → website_extractor`).
