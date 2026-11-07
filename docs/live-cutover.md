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
| 5 | Anthropic API key, with a monthly spend limit set in the Claude Console | `.dev.vars` `ANTHROPIC_API_KEY`; container secret | 2 | usage |
| 6 | Decide the website User-Agent contact URL (e.g. a page on ejtech.co.uk explaining the bot) | `HttpWebFetcher` option | 2 | free |
| 7 | Your Coinbase wallet ADDRESS (receive-only; never a private key) | Worker var `X402_PAY_TO` | 4 | free |
| 8 | An x402 facilitator URL (e.g. Coinbase CDP's) and, if it needs one, its API key | Worker var `X402_FACILITATOR_URL` (+ secret) | 4 | per their terms |
| 9 | A second, test wallet funded with Base Sepolia testnet USDC (to act as the paying agent) | your laptop only | 4 | free (faucet) |
| 10 | DNS: `check.oast-ai.com` (or similar) routed to the Worker for `/x402/*`, WITHOUT Access | Cloudflare | 4 | free |
| 11 | Companies House Streaming API key (separate from the REST key) | runner secret `CH_STREAM_KEY` | 4 | free |
| 12 | Set your real launch prices | `packages/config/src/products.json` | 4 | — |

## B. Assumptions to verify against live docs

### Phase 1 — Companies House (details in `docs/sources/companies-house.md`)
- [ ] 1–10 in `docs/sources/companies-house.md` (auth, rate limit, field names, bulk/accounts file formats, ONS columns)
- [ ] Rate-limit header names `X-Ratelimit-Remain` / `X-Ratelimit-Reset` (epoch seconds) — the limiter is driven by them

### Phase 2 — Claude API and websites
- [ ] Re-check the Claude API request shape in `packages/ports/src/anthropic.ts` against current docs (model ids, `output_config.format`, `fallbacks: "default"` + beta header) — written against `@anthropic-ai/sdk` 1.6.0 types
- [ ] Model prices in `packages/config/src/models.json` (cached from the Claude API reference, 2026-10-06) and the USD→GBP rate
- [ ] Wire the real adapters in the agent runner (`AnthropicModelClient`, `HttpWebFetcher`, `DomainGuessFinder`) behind a `LIVE=1` switch; keep fakes as the default

### Phase 4 — x402 and streaming
- [ ] x402 v2 protocol details against current docs: header names, `PaymentRequirements` shape, `exact` scheme `extra` fields (`name`/`version` for USDC EIP-712), Base Sepolia/Base USDC contract addresses in `products.json`
- [ ] Facilitator API: does `HTTPFacilitatorClient` need auth headers for your facilitator? (`packages/products/src/x402-real.ts`)
- [ ] Consider `@x402/hono` middleware vs our gate (see decisions)
- [ ] Streaming API: host, paths, auth, event JSON shape and `timepoint` resume (`packages/verification/src/sources/companies-house/stream.ts`)

## C. Prompts to test on the real model
Run each against ~20 real companies; check outputs by hand before relying on them.
- [ ] `website_extract` v1 (`packages/verification/src/sources/website/prompts.ts`): exact quotes, allow-listed fields only, role-based emails only; try pages with injected instructions
- [ ] `opportunity_explain` v1 (`packages/opportunity/src/explain.ts`): cites only trace facts; the code check falls back to a template otherwise — measure how often
- [ ] `sme_outreach_draft` v1 (`packages/infra/src/playbooks/sme_outreach.ts`): uses brief statements verbatim; measure how often the checker rejects; read 20 drafts for tone

## D. Live gate runs
### Phase 0
- [ ] `pnpm cf:deploy`, enable Access, redeploy; open the URL logged out (blocked) and logged in (health ok)
### Phase 1
- [ ] Follow `docs/runbooks/phase1-ingestion.md`; `pnpm gate:phase1` shows ≥ 10,000 ingested, 100% anchored
### Phase 2
- [ ] Website ingestion on the real universe (start with 100 companies; check quarantine and rejected extractions)
- [ ] Run `lead_gen_sme_web` on the day of the data refresh; check the top 20 by hand
- [ ] Approve 50 leads; read all 50 drafts; record cost per draft from the run log (`/api/tasks/:id`)
### Phase 3
- [ ] Hand-verify 150 companies in the dashboard (Golden set page); read Metrics → accuracy and calibration
- [ ] Schedule `pnpm nightly` (laptop cron, or Cloudflare Cron Trigger once deployed) and `pnpm digests` weekly
- [ ] After the pilot's first 30-day window closes: `pnpm weights suggest`, read the block in the note, accept or reject
- [ ] Backtest `lead_gen_sme_web` on real outcomes; promote to live only if lift ≥ 3×
### Phase 4
- [ ] Testnet: set `X402_FACILITATOR_URL`, `X402_PAY_TO`, deploy, turn the kill switch off for `x402_check` only, pay for one check from the test wallet; confirm the transaction on a Base Sepolia explorer and in `payments_ledger`
- [ ] Measure median latency (cached, premium) from `x402_requests` and margin per call
- [ ] Switch to mainnet (`network` + `asset` in `products.json`) only after the testnet run
- [ ] Start the stream consumer in the runner with `CH_STREAM_KEY`; check re-verification requests appear
