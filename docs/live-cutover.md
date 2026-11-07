# Live cutover checklist (the one end-of-build list)

Everything is built and tested on synthetic data with fakes. This file is the single list of what's
needed to go live, in order. Tick items as you go. **Nothing external happens until step 9.**

## A. Keys and accounts, in the order you need them

| # | What | Where it goes | Phase | Cost |
|---|---|---|---|---|
| 1 | Cloudflare account on Workers Paid | — | 0 | $5/mo |
| 2 | `wrangler login` on your laptop (or an API token: Workers Edit + D1 Edit) | laptop / GitHub secrets | 0 | free |
| 3 | Cloudflare Access on the workers.dev URL; copy AUD tag + team domain into `wrangler.jsonc` vars | Cloudflare dashboard | 0 | free |
| 4 | Companies House REST API key | `.dev.vars` `CH_API_KEY`; Worker secret | 1 | free |

## B. Assumptions to verify against live docs

### Phase 1 — Companies House (details in `docs/sources/companies-house.md`)
- [ ] 1–10 in `docs/sources/companies-house.md` (auth, rate limit, field names, bulk/accounts file formats, ONS columns)
- [ ] Rate-limit header names `X-Ratelimit-Remain` / `X-Ratelimit-Reset` (epoch seconds) — the limiter is driven by them

## C. Prompts to test on the real model
(none yet — added from Phase 2)

## D. Live gate runs
### Phase 0
- [ ] `pnpm cf:deploy`, enable Access, redeploy; open the URL logged out (blocked) and logged in (health ok)
### Phase 1
- [ ] Follow `docs/runbooks/phase1-ingestion.md`; `pnpm gate:phase1` shows ≥ 10,000 ingested, 100% anchored
