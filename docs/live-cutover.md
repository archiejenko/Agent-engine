# Live cutover checklist (the one end-of-build list)

Everything is built and tested on synthetic data with fakes. This is the single list of what's needed
to go live, **ordered by time to cash**: each stage unblocks the next, and the earliest revenue (your
website outreach) comes first. Tick items as you go. Nothing external happens until you turn a kill
switch off; the global kill switch defaults to ON.

| Stage | What it unlocks | Revenue path |
|---|---|---|
| 1 Cloudflare | the dashboard and API, behind Access | — |
| 2 Companies House | real company data | — |
| 3 Anthropic | real extraction, explanations and drafts | — |
| 4 Ingestion | the real Greater Manchester universe, websites, verified facts | — |
| 5 Real drafts + prompt tests | the first 50 real drafts; model choice per role | website outreach |
| 6 Email and letters | first real emails and the first printed letter batch | website outreach (**first cash**) |
| 7 x402 | paid company checks for AI agents | x402 |
| 8 Stripe | monitoring alerts and the £9 human report | monitoring, human check |

Out of scope: **phone outreach**. If it's ever added, every number must be screened against the
**CTPS** (Corporate Telephone Preference Service, and TPS for sole traders/partnerships) before any
call, with the screen date stored per number, like the email suppression list.

---

## Stage 1 — Cloudflare

Keys and accounts
- [ ] Cloudflare account on Workers Paid ($5/month)
- [ ] `wrangler login` on your laptop (or an API token with Workers Edit + D1 Edit, as a GitHub secret)
- [ ] Cloudflare Access on the workers.dev URL; copy the AUD tag and team domain into `apps/api/wrangler.jsonc` vars

Live run
- [ ] `pnpm cf:deploy`, enable Access, redeploy; open the URL logged out (blocked) and logged in (health ok)

## Stage 2 — Companies House

Keys
- [ ] Companies House REST API key → `.dev.vars` `CH_API_KEY` and Worker secret

Verify against live docs
- [ ] Items 1–10 in `docs/sources/companies-house.md` (auth, rate limit, field names, bulk/accounts file formats, ONS columns)
- [ ] Rate-limit headers `X-Ratelimit-Remain` / `X-Ratelimit-Reset` (epoch seconds): the limiter is driven by them

## Stage 3 — Anthropic

Keys
- [ ] Anthropic API key with a monthly spend limit set in the Claude Console → `.dev.vars` `ANTHROPIC_API_KEY`, runner secret

Verify against live docs
- [ ] Request shape in `packages/ports/src/anthropic.ts` (written against `@anthropic-ai/sdk` 1.6.0): model ids, `output_config` (effort, `format`), server-side refusal `fallbacks: "default"` + beta header `server-side-fallback-2026-07-01`
- [ ] Which models accept server-side `fallbacks` (`SERVER_FALLBACK_MODELS` in `anthropic.ts`: Opus 5.5, Sonnet 5.5; **not Haiku 5.5**, which gets no `fallbacks` field — tested)
- [ ] Prices in `packages/config/src/models.json` (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 per Mtok, cached 2026-11-03; Haiku's price rises above 100K-token prompts, ours are far smaller) and the USD→GBP rate
- [ ] Wire the real adapters in the agent runner (`AnthropicModelClient`, `HttpWebFetcher`, `DomainGuessFinder`) behind a `LIVE=1` switch; keep fakes as the default

## Stage 4 — Ingestion

Live runs
- [ ] Follow `docs/runbooks/phase1-ingestion.md`; `pnpm gate:phase1` shows ≥ 10,000 ingested, 100% anchored
- [ ] Decide the website User-Agent contact URL (e.g. a page on ejtech.co.uk explaining the crawler) → `HttpWebFetcher` option
- [ ] Website ingestion on the real universe: start with 100 companies; check quarantine and rejected extractions
- [ ] Site-level website facts (site exists, last updated, HTTPS/mobile, contact email) now hold their confidence for 90 days, then go stale. Schedule the re-crawl every ~90 days (no more often); check `pnpm gate:phase2`'s shelf-life line on real data
- [ ] Optional, any time after this: Companies House Streaming API key → runner secret `CH_STREAM_KEY`; check host, paths, auth, event shape and `timepoint` resume (`packages/verification/src/sources/companies-house/stream.ts`); start the consumer and check re-verification requests appear

## Stage 5 — Real drafts and prompt tests (model comparison)

Hand-verify first, so the comparison has a yardstick
- [ ] Hand-verify 150 companies on the Golden set page; read Metrics → accuracy and calibration

Prompts on the real model (~20 real companies each; read every output)
- [ ] `website_extract` v1 (`packages/verification/src/sources/website/prompts.ts`): exact quotes, allow-listed fields only, role-based emails only; include pages with injected instructions
- [ ] `opportunity_explain` v1 (`packages/opportunity/src/explain.ts`): cites only trace facts; measure how often the code check falls back to the template
- [ ] `sme_outreach_draft` v1 (`packages/infra/src/playbooks/sme_outreach.ts`) and `sme_letter_draft` v1 (`packages/infra/src/playbooks/sme_letter.ts`): brief statements used verbatim; measure checker rejections; read 20 of each for tone

Model comparison (a config change: `roles` in `packages/config/src/models.json`, no code)
- [ ] **Extraction: Haiku 5.5 vs Opus 5.5** (`extractor` role) on the same 100 websites. Compare: extractions rejected because the value isn't in the evidence span; accuracy against the golden set (Metrics); injected-instruction pages handled; cost per company. Switch to Haiku only if accuracy is within ~2 points and no injection gets through
- [ ] **Drafting: Sonnet 5.5 vs Opus 5.5** (`writer` role: emails and letters) on the same 20 briefs. Compare: checker pass rate first time; your edit rate (approved without edits); tone (your read); cost per draft (run log). Switch only if pass rate and edit rate hold
- [ ] Record the result and the choice in `docs/decisions.md`

Live run
- [ ] Run `lead_gen_sme_web` on the day of a data refresh; check the top 20 by hand
- [ ] Approve 50 leads; read all 50 drafts (emails in Review, letters in Letters); record cost per draft from the run log (`/api/tasks/:id`). Expect many letters: on synthetic data all top-50 leads had no website

## Stage 6 — Email and letters (first cash)

Keys and accounts
- [ ] A sending domain you own (e.g. mail.ejtech.co.uk) with SPF, DKIM and DMARC
- [ ] Email provider account + API key (e.g. Postmark, SES, Resend) → runner secret. Needs a real `EmailSender` adapter (about an hour)
- [ ] Inbox access for replies (provider inbound webhook or IMAP) → needs a real `Inbox` adapter
- [ ] Your real sender details in `packages/config/src/infra.json` → `sender`: from address, company name, **postal address** (letters must identify you; it's printed on every letter)
- [ ] Demo host for letters: e.g. `demo.ejtech.co.uk` routed to the Worker for `/demo/*` **and** `/stop/*` (the short opt-out URL printed on every letter), **without** Access; set `letters.demo_base_url` in `infra.json` (QR codes and opt-out URLs point there). Keep it short: it's typed by hand

Verify against current guidance
- [ ] UK outreach rules (PECR/GDPR, ICO guidance on B2B email to corporate subscribers): the company-type rule and the opt-out wording
- [ ] Letters: post isn't covered by PECR, but GDPR's right to object is; confirm the letter opt-out wording, and how you'll record "no more letters" (add the company to the suppression list as `entity:<company number>`)
- [ ] Email provider API and inbound reply format for the real adapters

Live run
- [ ] First 5 real emails: turn the global kill switch off, approve each by hand, check each arrives with sender details + opt-out; reply "no thanks" from a test inbox and confirm suppression
- [ ] Before the first batch: print one letter and check the opt-out line is readable, type its short URL on a phone and opt out (check `entity:<number>` appears in suppressions), and email the code to your inbox address and check the same. Then remove the test suppression
- [ ] First print batch: open Letters, read the flagged letters (registered office looks like an accountant's: see `docs/known-biases.md`), leave out any you don't want, approve, download the PDF, print and post. Turn the kill switch off for `sme_letter` so the demo links work; scan one QR from the printed page
- [ ] Zero guardrail breaches over the first 50 tasks (Controls page); only then consider L2

## Stage 7 — x402 (paid checks for AI agents)

Keys and accounts
- [ ] Your Coinbase wallet ADDRESS (receive-only; never a private key) → Worker var `X402_PAY_TO`
- [ ] An x402 facilitator URL (e.g. Coinbase CDP's) → Worker var `X402_FACILITATOR_URL`; if it needs auth, pass `createAuthHeaders` to `HttpX402Facilitator` (`packages/products/src/x402-real.ts`) and store the key as a Worker secret
- [ ] A second, test wallet funded with Base Sepolia testnet USDC, to act as the paying agent (your laptop only)
- [ ] DNS: `check.oast-ai.com` (or similar) routed to the Worker for `/x402/*`, WITHOUT Access
- [ ] Your real launch prices → `products.json` → `x402.prices_usd`

Verify against the x402 v2 spec (we now use the official `@x402/hono` middleware, `x402ResourceServer` and `ExactEvmScheme` 2.30.0; tests cover each item below on the fake facilitator)
- [ ] **Headers**: `PAYMENT-REQUIRED` (402 response, base64 JSON `PaymentRequired`, `x402Version: 2`), `PAYMENT-SIGNATURE` (request, base64 JSON `PaymentPayload`), `PAYMENT-RESPONSE` (200 response, base64 JSON settlement)
- [ ] **CAIP-2 network ids**: `eip155:84532` = Base Sepolia (testnet, now), `eip155:8453` = Base mainnet; check your facilitator's `/supported` lists the one you use
- [ ] **USDC EIP-712 domain**: Base Sepolia USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, name **"USDC"**, version "2", 6 decimals; Base mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, name **"USD Coin"**, version "2". The names differ: when moving to mainnet change `network`, `asset` **and** `eip712.name` in `products.json` together (a test fails if config disagrees with the library's table)
- [ ] **Replay protection**: each EIP-3009 authorization carries a unique 32-byte `nonce` and a validity window (`validAfter` ≤ now < `validBefore`, at most `maxTimeoutSeconds` = 60s ahead); the facilitator and the USDC contract refuse reused nonces and out-of-window payments. Confirm your facilitator enforces both (ours does in the fake; tested)
- [ ] **Settle after success only**: the middleware settles only when our handler answers < 400 (a failed premium re-check or unknown company is never charged); a settle timeout is an indeterminate outcome, check the ledger before retrying
- [ ] Worker runs with `compatibility_flags: ["nodejs_compat"]` (the middleware uses `Buffer`); the bundle test covers it

Live runs
- [ ] Testnet: set the vars, deploy, turn the kill switch off for `x402_check` only, pay for one check from the test wallet; confirm the transaction on a Base Sepolia explorer and in `payments_ledger`
- [ ] Measure median latency (cached, premium) from `x402_requests` and margin per call
- [ ] Switch to mainnet (see the EIP-712 item) only after the testnet run

## Stage 8 — Stripe (monitoring and the human report)

Keys and accounts
- [ ] Stripe account; test-mode secret key first → Worker secret `STRIPE_SECRET_KEY`
- [ ] Stripe webhook endpoint `https://<public host>/webhooks/stripe` for `checkout.session.completed`; copy its signing secret → Worker secret `STRIPE_WEBHOOK_SECRET`; var `PUBLIC_BASE_URL`
- [ ] Your monitoring and report prices → `products.json` → `monitoring`, `human_check`

Verify against live docs
- [ ] Checkout Session params (`StripeCheckout` in `packages/ports/src/payments.ts`) and the `checkout.session.completed` event shape (`verifyStripeWebhook`); signature `t=…,v1=…` with 5-minute tolerance
- [ ] Build monitoring renewals on Stripe Subscriptions (`mode=subscription`, `invoice.paid`, `customer.subscription.deleted`): v1 watches never expire (see decisions)

Live runs
- [ ] Test mode: buy a £9 report with a test card; check one `human_report` task, the report email in the outbox, and that replaying the webhook creates no second task
- [ ] Buy monitoring for 5 companies (test mode); trigger a change (or wait for one); check one alert is delivered
- [ ] Switch Stripe to live mode

## Ongoing (once live)

- [ ] Schedule `pnpm nightly` (laptop cron, or a Cloudflare Cron Trigger once deployed) and `pnpm digests` weekly
- [ ] After the pilot's first 30-day window closes: `pnpm weights suggest`, read the block in the note, accept or reject
- [ ] Backtest `lead_gen_sme_web` on real outcomes; promote to live only if lift ≥ 3×
