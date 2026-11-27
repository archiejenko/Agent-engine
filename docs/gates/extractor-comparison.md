# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

**No results yet.**

**Run attempted 2026-11-27 16:23 UTC: every Hydrogen call was refused by Google.**
- 20 fixture sites were sent to `gemini-4-hydrogen` with the extractor's real prompt and schema.
- 19 calls came back **HTTP 402, "Your prepayment credits are depleted. Please go to AI Studio at
  https://ai.studio/projects to manage your project and billing."** The other one came back HTTP 503.
- No call returned a model answer, so nothing was billed and there's nothing to score.
- The Opus side didn't run either: there's no `ANTHROPIC_API_KEY` in this session.

**To run it** (about £1 for 20 pages, both models together):
1. Add prepaid credit to the Google AI Studio project that owns `GEMINI_API_KEY`
   (https://ai.studio/projects → billing).
2. Make `ANTHROPIC_API_KEY` available: in `.dev.vars` on the laptop, or as an environment variable in
   this repo's cloud environment.
3. Run:

```bash
pnpm compare:extractors --pages 20
```

The script then sends the synthetic-world fixture sites (3 pages each, cut by the per-page budget)
through both models. It scores every field against the fixtures' known answers (company number,
trading postcode, role email, job postings). It counts wrong, missing and extra fields, including the
planted prompt injection, and checks agreement between the models. It also reports average cost per
call and latency, and overwrites this file. With only the Gemini key it runs Hydrogen alone against the
known answers. If every call fails, it writes nothing. There are no real cached pages in the repo to
add.

**Until it has been run, the extractor stays on Claude Opus 5.5** (`models.json → website_extractor`).
