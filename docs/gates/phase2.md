# Phase 2 gate report

Generated 2026-11-09T22:02:18.914Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Website facts stay usable for their 90-day shelf life (floor 0.7, no extra crawls) | passed (synthetic) | top-20 leads: 20 site-level facts ≥ 0.7 today, 20 at +60 days, 0 at +95 days (stale → re-crawl due) |
| Top 20 ranked, fully traced leads | passed (synthetic) | 20 leads; 0 trace problems; 50/50 rationales written by the model and passed the check (others used the template) |
| 50 drafts generated | passed (synthetic) | 50 tasks (0 email, 50 letter for leads with no emailable address); 50 drafts waiting for approval; 0 stopped by the checker for review |
| Every claim in every draft traces to a verified fact | passed (synthetic) | 50 claims checked across 50 drafts; 0 problems |
| Cost per draft reported | passed (synthetic) | £0.0032 per draft with the fake model's token counts at claude-opus-5-5-equivalent prices; website extraction £0.0020 per company |
| Same, on real data with the real model | live pending | needs CH key, real web fetches and ANTHROPIC_API_KEY (docs/live-cutover.md) |

Synthetic world: 3000 companies → 1528 scored leads, 245 above threshold or exploration picks.
Top 5: 10000068 (0.80), 10000340 (0.80), 10000476 (0.80), 10000680 (0.80), 10001632 (0.80).


