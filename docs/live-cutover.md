# Live cutover checklist (the one end-of-build list)

Everything is built and tested on synthetic data with fakes. This is the single list of what's needed
to go live, **ordered by time to cash**: each stage unblocks the next, and the earliest revenue (your
website outreach) comes first. Tick items as you go. Nothing external happens until you turn a kill
switch off; the global kill switch defaults to ON.

| Stage | What it unlocks | Revenue path |
|---|---|---|
| 1 Cloudflare | the dashboard and API, behind Access; keys (1b), replies inbox (1c), GitHub settings (1d) | — |
| 2 Companies House | real company data | — |
| 3 Anthropic | real extraction, explanations and drafts | — |
| 4 Ingestion | the real Greater Manchester universe, websites, verified facts | — |
| 5 Real drafts + prompt tests | the first 50 real drafts; model choice per role | website outreach |
| 0 Legal groundwork (v2) | lawful basis, ICO fee, privacy notices, terms | everything that contacts people |
| 6 Email and letters | first real emails and the first printed letter batch | website outreach (**first cash**) |
| 6b Claim this site (v2) | setup fee + monthly subscriptions from sample pages | website outreach (**recurring cash**) |
| 7 x402 | paid company checks for AI agents | x402 |
| 8 Stripe | monitoring alerts and the £9 human report | monitoring, human check |

Out of scope: **phone outreach**. If it's ever added, every number must be screened against the
**CTPS** (Corporate Telephone Preference Service, and TPS for sole traders/partnerships) before any
call, with the screen date stored per number, like the email suppression list.

---

## Stage 0 — Legal groundwork (v2; before Stage 6, can run in parallel with 1–5)

- [ ] **Legitimate interests assessment (LIA)** for B2B outreach by email and post: purpose, necessity,
  balancing test, the opt-out on every message, the 90-day per-company cooldown, the random holdout (15%
  of each outreach cohort is chosen at random rather than ranked: same rules, same opt-out). Keep it on file.
- [ ] **ICO registration**: pay the data protection fee for EJTECH Ltd (tier 1 unless turnover/staff
  say otherwise) and note the registration number in `infra.json` → `sender` if you want it shown.
- [ ] **Privacy notice** on ejtech.co.uk covering: where company and director data comes from
  (Companies House, the company's own website), what we keep and for how long, the suppression list,
  how to object. Link it from every email footer, letter and demo page.
- [ ] **Demo-page privacy line** (already on every sample page): "records that it was opened and for how
  long. No cookies… no IP address or device details". Confirm it matches the notice above.
- [ ] **Claim-this-site terms**: solicitor's read of `products.json` → `claim_site.terms` (draft): B2B
  only, setup fee + monthly, cancel any time, 14-day refund if work hasn't started, domain as a separate
  proposal. Bump `terms_version` when it changes (it's recorded on each claim).

## Stage 1 — Cloudflare

Keys and accounts
- [ ] Cloudflare account on Workers Paid ($5/month)
- [ ] `wrangler login` on your laptop (or an API token with Workers Edit + D1 Edit, as a GitHub secret)
- [ ] Cloudflare Access on the workers.dev URL; copy the AUD tag and team domain into `apps/api/wrangler.jsonc` vars

Live run
- [ ] `pnpm cf:deploy`, enable Access, redeploy; open the URL logged out (blocked) and logged in (health ok)

v2 runtime (all in `apps/api/wrangler.jsonc`; `wrangler deploy` creates the queues and Durable Objects)
- [ ] D1 migrations 0010–0013 applied (`pnpm cf:deploy` applies them); `/api/health` shows 13
- [ ] Queues `ae-jobs` and `ae-jobs-dlq` exist; the Cron Trigger (every 5 min) appears on the Worker
- [ ] Durable Objects `ChangeFeed` and `BudgetObject` (SQLite-backed) and the `ae-engine` Workflow exist
- [ ] Controls → Runtime health: "Scheduled trigger", "Agent loop" and "Job queue" ran in the last 10 minutes
- [ ] Force one failing job (e.g. a `reverify` for a made-up company with the CH key removed) and check it
  lands in "Needs a person" after 3 retries, with an alert
- [ ] Controls → Budgets shows today's spend against the caps; leave every playbook on S0 at first

v3 dashboard (Milestone C)
- [ ] D1 migrations 0014–0018 applied (decisions, mailbox, Vault versions, key registry, ideas backlog); `/api/health` shows 18
- [ ] Open the root URL: it goes straight to the dashboard (Home). There is no public landing page
- [ ] Needs you shows decisions; the daily digest appears on Home after the first 06:00 UTC run
- [ ] Vault lists `brain/` (bundled at deploy by `pnpm gen:brain`, which `pnpm cf:deploy` runs). Then
  check Vault → Ideas sheet shows the 500 ideas labelled "estimate", then press "Import into the backlog"

### Stage 1b — Keys (v3, decision D4; runbook `docs/runbooks/keys.md`)
- [ ] Secrets Store created; store ID copied. **Check that Secrets Store is out of beta, or that its beta
  limits suit you**
- [ ] Token with **Account Secrets Store Edit only** → `wrangler secret put CF_SECRETS_TOKEN`
- [ ] `CF_ACCOUNT_ID` and `SECRETS_STORE_ID` in `wrangler.jsonc` vars; the `secrets_store_secrets` block added
- [ ] Save one harmless key on Controls → Keys and confirm it shows "saved, not used yet". This first save
  verifies the Secrets Store list and replace calls, which are marked unverified
- [ ] From here on, keys go in through the Keys page, not `wrangler secret put` (Worker secrets still work
  as a fallback)

### Stage 1c — Replies inbox (v3, decision D1)
- [ ] Choose a dedicated reply address on the sending domain, e.g. `replies@<sending domain>` (never your
  own inbox)
- [ ] Cloudflare Email Routing on that domain: route the address to **the Worker** (Email Workers). The
  Worker's `email()` handler stores each message in the mailbox as untrusted, and never forwards it
- [ ] Send a test email to it: it should appear in Inbox → Replies within a minute
- [ ] When you shortlist a sending provider, **check its terms allow B2B cold outreach**, then add
  `EMAIL_API_KEY` on the Keys page

### Stage 1d — GitHub settings (v3, decision D5; manual)
- [ ] **CODEOWNERS**: add `.github/CODEOWNERS` naming you as owner of the safety layer:
  - `packages/infra/src/tools.ts`, `controls.ts`, `budget.ts`, `autonomy.ts`, `decisions.ts`, `keys.ts`;
  - `packages/contracts/`, `packages/config/src/*.json`, `packages/storage/migrations/`;
  - `tests/architecture.test.ts`, `.github/`.

  Agents may never change these (rule 14).
- [ ] **Branch protection** on `main`: require a pull request, require your review from code owners,
  require the CI check (`pnpm check`), no force pushes, and **no auto-merge**
- [ ] Only if Claude Code ever runs from GitHub (Milestone D): it triggers on your label or comment only,
  never on a schedule, with narrow permissions, and code changes never auto-merge

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
- [ ] On Workers (v2): Worker secret `ANTHROPIC_API_KEY` and var `MODEL_LIVE="1"` switch the runtime from the fake model to Claude (both are needed)

## Stage 4 — Ingestion

Live runs
- [ ] Follow `docs/runbooks/phase1-ingestion.md`; `pnpm gate:phase1` shows ≥ 10,000 ingested, 100% anchored
- [ ] Decide the website User-Agent contact URL (e.g. a page on ejtech.co.uk explaining the crawler) → `HttpWebFetcher` option
- [ ] Website ingestion on the real universe: start with 100 companies; check quarantine and rejected extractions
- [ ] Site-level website facts (site exists, last updated, HTTPS/mobile, contact email) now hold their confidence for 90 days, then go stale. Schedule the re-crawl every ~90 days (no more often); check `pnpm gate:phase2`'s shelf-life line on real data
- [ ] Optional, any time after this: Companies House Streaming API key → **Worker secret** `CH_STREAM_KEY` (v2: the `ChangeFeed` Durable Object reads it on an alarm). Check host, paths, auth, event shape (incl. `data.category` on filings and `data.company_status` on companies, used by the trigger rules) and `timepoint` resume (`packages/verification/src/sources/companies-house/stream.ts`); Controls → Runtime health should then say "change feed: connected" and polling stops
- [ ] Read the trigger rules in `packages/config/src/triggers.json` (which changes act; only "a lead filed accounts" calls the model)

## Stage 5 — Real drafts and prompt tests (model comparison)

> **Feature freeze until this stage is done** (2026-11-10): only fixes needed for the cutover itself.

Hand-verify first, so the comparison has a yardstick
- [ ] Hand-verify 150 companies on the Golden set page; read Metrics → accuracy and calibration

Prompts on the real model (~20 real companies each; read every output)
- [ ] `website_extract` v1 (`packages/verification/src/sources/website/prompts.ts`): exact quotes, allow-listed fields only, role-based emails only; include pages with injected instructions
- [ ] `opportunity_explain` v1 (`packages/opportunity/src/explain.ts`): cites only trace facts; measure how often the code check falls back to the template
- [ ] `sme_outreach_draft` v2 (`packages/infra/src/playbooks/sme_outreach.ts`) and `sme_letter_draft` v2 (`packages/infra/src/playbooks/sme_letter.ts`): one brief statement verbatim as the first sentence, why it matters, then the offer; measure how often the copy rules reject a draft and which rule; read 20 of each for tone and repeated phrases (the checker doesn't catch repetition)

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
- [ ] **Trading disclosures** in `infra.json` → `sender.legal`: EJTECH's exact registered name, company number and registered office (currently placeholders `00000000` / "Registered office placeholder"). They print on every letter, email footer and demo page; real sends refuse to run and Letters says "Don't print yet" until they're set
- [ ] Real print and postage costs per letter → `infra.json` → `letters.print_cost_gbp`, `postage_gbp` (placeholders £0.12 + £0.87)
- [ ] Read the demo-page sector copy in `packages/config/src/sic-sectors.json` (17 sectors + default) and adjust the wording to your voice
- [ ] Demo host for letters: e.g. `demo.ejtech.co.uk` routed to the Worker for `/demo/*` **and** `/stop/*` (the short opt-out URL printed on every letter), **without** Access; set `letters.demo_base_url` in `infra.json` (QR codes and opt-out URLs point there). Keep it short: it's typed by hand

Verify against current guidance
- [ ] UK outreach rules (PECR/GDPR, ICO guidance on B2B email to corporate subscribers): the company-type rule and the opt-out wording
- [ ] Letters: post isn't covered by PECR, but GDPR's right to object is; confirm the letter opt-out wording, and how you'll record "no more letters" (add the company to the suppression list as `entity:<company number>`)
- [ ] Email provider API and inbound reply format for the real adapters

- [ ] **Sending-domain warm-up**: a dedicated sending subdomain (never the claim-sites domain, D6); start
  at ~10 emails/day for the first week, double weekly while bounces stay < 2% and complaints < 0.1%;
  watch DMARC reports. The per-playbook spend tier (S0) and daily caps already keep volume low.
- [ ] Note that each outreach approval adds a **random holdout** (15%, same compliance checks, looks the
  same in Review): that's how Metrics can say whether ranking beats random. Rejecting holdout drafts is
  fine; it's reported separately.

Live run
- [ ] First 5 real emails: turn the global kill switch off, approve each by hand, check each arrives with sender details + opt-out; reply "no thanks" from a test inbox and confirm suppression
- [ ] Before the first batch: print one letter and check the opt-out line is readable, type its short URL on a phone and opt out (check `entity:<number>` appears in suppressions), and email the code to your inbox address and check the same. Then remove the test suppression
- [ ] First print batch: open Letters, read the flagged letters (registered office looks like an accountant's: see `docs/known-biases.md`), leave out any you don't want, approve, download the PDF, print and post. Turn the kill switch off for `sme_letter` so the demo links work; scan one QR from the printed page
- [ ] Zero guardrail breaches over the first 50 tasks (Controls page); only then consider L2

## Stage 6b — Claim this site (v2: setup fee + monthly subscription)

Keys and accounts (Stripe in **test mode only**: a live key switches card payments off, v2 rule 9)
- [ ] Stripe test-mode secret key → Worker secret `STRIPE_SECRET_KEY`; webhook signing secret →
  `STRIPE_WEBHOOK_SECRET`; var `PUBLIC_BASE_URL` (the claim-sites host)
- [ ] Webhook endpoint `https://<public host>/webhooks/stripe` with events `checkout.session.completed`,
  `invoice.paid`, `customer.subscription.deleted`, `charge.refunded`
- [ ] Your prices → `products.json` → `claim_site.setup_fee_gbp`, `monthly_gbp`; the claim-sites host →
  `claim_site.base_url` (a subdomain of ejtech.co.uk that never sends email, D6)
- [ ] Route `/claim/*`, `/public/claim/*` and `/s/*` on that host to the Worker **without** Access

Verify against live docs (not possible from the build environment: Stripe's docs were blocked)
- [ ] **Build** `StripeCheckout.createSubscriptionCheckout` (`packages/ports/src/payments.ts`): Checkout
  Session in subscription mode with a recurring monthly price plus a one-off setup line item. It refuses
  to run until this is done
- [ ] Check every field in `toSubscriptionEvent` (same file, marked UNVERIFIED): `mode`, `subscription`,
  `amount_total`, `invoice.amount_paid`, `billing_reason` (`subscription_create` for the first invoice),
  how a refunded charge links back to its subscription (we use `metadata.subscription_id`; Stripe may
  need the invoice/payment intent instead)

Live runs (test mode)
- [ ] Turn the kill switch off for `sme_letter` and `claim_site`; open a sample page, "Claim this site",
  pay with a test card; check the claim appears (Letters → Claimed sites), the details-form email in the
  outbox, the `paid` row in the outcome ledger attributed to the letter
- [ ] Fill the details form; read the draft on the dashboard; approve; check the site at `/s/<slug>` and
  the domain-proposal email
- [ ] Replay the payment webhook from the Stripe dashboard: no second fulfilment
- [ ] Cancel the test subscription: the claim shows cancelled, fulfilment stops, the site comes down
- [ ] Your minutes for that claim vs the 30-minute target (Claimed sites)

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
