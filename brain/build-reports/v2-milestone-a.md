---
type: build-report
milestone: v2-A
date: 2026-11-16
status: STOPPED — waiting for Archie
---

# v2 Milestone A: stop-point report

Milestone A (v2 Phases 1–4) is built and every gate passes on synthetic data in dry-run. Stripe ran in
test mode against the fake. **I've stopped here, as planned.** Milestone B (Phases 5–9) stays frozen until
real outcomes exist.

## 1. Gate results

| Phase | What it is | Gate | Report |
|---|---|---|---|
| 1 | Outcome ledger, cohorts + blind random holdout, EV send gate, demo-page visits, unit economics with your minutes | **9/9 passed (synthetic)** | `brain/build-reports/v2-phase-1.md`, `docs/gates/v2-phase1.md` |
| 2 | Workers runtime: Cron → Queue + dead-letter queue, Workflows, recorded external effects, change feed + polling, trigger rules, health page | **8/8 passed** (7 synthetic + Worker build) | `v2-phase-2.md`, `docs/gates/v2-phase2.md` |
| 3 | Hard budgets in a Durable Object, spend tiers S0–S3, L3 behind your approval, weekly explore share | **5/5 passed (synthetic)** + Worker build | `v2-phase-3.md`, `docs/gates/v2-phase3.md` |
| 4 | Claim this site (setup + monthly), fulfilment workflow, webhook replay/cancel safety, post-reply (L0) | **7/7 passed (synthetic, test mode)** | `v2-phase-4.md`, `docs/gates/v2-phase4.md` |

**Tests:**
- `pnpm check` is green: 374 tests in 46 files, typecheck (including the Worker's own) and lint.
- Each gate also runs in CI at a small size.
- The Worker builds with every binding (`wrangler deploy --dry-run`): D1, the `JOBS` queue, the
  `CHANGE_FEED` and `BUDGET` Durable Objects, and the `ENGINE` workflow.

**v2 rules, each enforced in code with a test:**

| Rule | Where it's enforced | Test |
|---|---|---|
| 9 Dry-run stays on; Stripe test mode only | kill switch default ON; `assertStripeTestMode`; the real subscription call refuses to run | gate 4 |
| 10 Synthetic data never trains anything | `synthetic` on tasks, outbox, letters, ledger, claims; the learning filter | unit test + gate 1 |
| 11 Point-in-time learning | ledger learning filter (`created_at` and `observed_at` ≤ as-of) | unit test |
| 12 Scoring learns from the ledger only | P(paid) reads the ledger only | behavioural test + static check |
| 13 The proposer never grades itself | Milestone B (frozen) | — |
| 14 Agents can't change the safety layer | static checks; owner approvals created only by the dashboard API | `tests/architecture.test.ts` |
| 15 Truthful labelling | copy rules + writer prompts; reply rules | unit tests |
| 16 Compliance gates on every send, including holdout | `assessCandidates` shared by ranked and holdout | gate 1 |
| 17 No repeated external actions | `external_effects`, recorded before every external tool call | gate 2 + unit test |

**Bugs the gates caught and I fixed:**
- Trigger events past 500 in a batch were silently dropped.
- A tool refusing *before* acting was logged as "outcome unknown", which blocked retries.
- A company that opted out of letters could still be drawn into the holdout for email. Opt-outs now
  cover every channel.
- Two of my own gate checks were too weak, and I tightened them:
  - the explore-share check passed only because a different cap bound first;
  - the runner-budget check counted other reservations.

## 2. What I couldn't do from here (needs you, or a session with access)

Two sets of API docs were **blocked by this build environment's network policy** (the proxy refused
them). The rule is to check current docs, not write from memory, so:

1. **Stripe subscriptions.** The claim flow, webhooks and fulfilment are built and tested against the
   fake Stripe. The two Stripe-specific pieces are isolated and marked:
   - the real subscription Checkout call **refuses to run**;
   - the event field names (`toSubscriptionEvent`) are marked **UNVERIFIED**.

   **To finish, either:**
   - allow `docs.stripe.com` for a session; or
   - paste the docs for Checkout Sessions (subscription mode), Invoice (`invoice.paid`), Subscription
     (`customer.subscription.deleted`) and Charge (`charge.refunded`).
2. **Companies House streaming.** The change feed uses the stream client built in an earlier phase, which
   was already flagged "verify at cutover". I couldn't re-check it. It runs only when you add the
   `CH_STREAM_KEY` secret; until then polling does the work.

   **To verify it, either:**
   - allow `developer-specs.company-information.service.gov.uk`; or
   - check it at cutover (Stage 4).

## 3. Every config value that needs a real number

All labelled as placeholders or assumptions in the files themselves.

**`packages/config/src/infra.json`**

| Value | Now | What sets it |
|---|---|---|
| `measurement.priors.reply_rate` | 0.03 | your first 100–200 real sends (it then learns from the ledger) |
| `measurement.priors.close_rate` | 0.15 | your history of replies → paid work |
| `measurement.priors.first_year_value_gbp` | 1500 | claim price: setup + 12 × monthly (£329 with the placeholders below, so set this to match) |
| `measurement.priors.strength` | 20 | how many sends the prior is "worth" |
| `measurement.holdout_share` | 0.15 | 10–20% allowed; higher answers sooner but costs more random sends |
| `measurement.letter_ev_k` | 3 | how much better than break-even a letter must look |
| `measurement.email_send_cost_gbp` | 0.001 | your email provider's price |
| `measurement.skip_flagged_registered_offices` | true | skip accountant/agent offices at intake (we hold no trading address) |
| `measurement.demo_visit_window_minutes` | 120 | how long after a visit the time-on-page beacon counts |
| `caps.spend_tiers` | S1 £10 · S2 £25 · S3 £60 | daily cap per playbook at each tier (S0 = the existing £5) |
| `caps.explore_share` | 0.10 | experiments' share of the weekly budget |
| `caps.step_reservation_gbp` | 0.25 | held back before each model step (real steps cost far less) |
| `letters.print_cost_gbp`, `postage_gbp` | 0.12, 0.87 | your printer and postage (unchanged from v1) |
| `sender.legal.*` | placeholders | EJTECH's registered name, number and office (real sends refuse until set) |

**`packages/config/src/products.json` → `claim_site`**

| Value | Now | |
|---|---|---|
| `setup_fee_gbp` | 149 | your price |
| `monthly_gbp` | 15 | your price |
| `details_wait_days` / `publish_wait_days` | 14 / 30 | how long fulfilment waits for the customer, then for you |
| `human_minutes_target` | 30 | your minutes per site before it shows red |
| `base_url` | https://sites.ejtech.example | a subdomain of ejtech.co.uk that never sends email (D6) |
| `terms` / `terms_version` | draft | legal review (below) |

**`packages/config/src/triggers.json`**

| Value | Now | |
|---|---|---|
| `fallback_poll.feed_stale_minutes` | 30 | when polling takes over |
| `fallback_poll.entities_per_poll` | 50 | per 5-minute run |
| `rules` | 5 rules | which changes act; only "a lead filed accounts" calls the model |

**`apps/api/wrangler.jsonc`**

| Value | Now | |
|---|---|---|
| cron | every 5 min | how often the loop runs |
| queue retries | 3, 60 s apart | before a job is set aside as a dead letter |
| `MODEL_LIVE` | "" | "1" plus the `ANTHROPIC_API_KEY` secret switches the Worker to Claude |

## 4. Legal questions (for a solicitor or the ICO guidance; I can't answer these)

1. **Lawful basis for B2B outreach.** Is legitimate interests right for emailing role addresses (info@,
   hello@) at limited companies, and for posting letters to "The Directors" at the registered office?
   The checklist now has a legitimate interests assessment (LIA) item covering the opt-out, the 90-day
   cooldown and the holdout.
2. **The random holdout.** Contacting a random 15% of eligible companies to measure whether ranking works.
   Does the LIA need to cover this explicitly? (It uses the same rules, opt-out and labelling as every
   other send.)
3. **Demo pages.** We publish a sample site using a company's public Companies House facts, with a "not
   affiliated" banner, noindex, a 30-day expiry and a privacy line. Any passing-off or trade-mark concern
   with using their registered name on the sample?
4. **Visit logging on demo pages.** We record open time, QR versus link, and visible time. No cookies,
   no IP address, no user agent. Does this need consent under PECR regulation 6 (storage/access on the
   device)? We store nothing on the device, but the script does read page visibility.
5. **Claim-this-site terms** (draft in `products.json`):
   - Is "business-to-business only" enforceable for sole traders who reach a sample page? We only write
     to limited companies, but a forwarded letter could reach someone else.
   - Do we need the consumer cancellation wording (Consumer Contracts Regulations, 14 days) anyway?
   - Is the 14-day setup-fee refund "if work hasn't started" fair?
6. **ICO registration tier** and whether the registration number should appear on letters.
7. **Retention.** How long to keep outreach records, suppression entries (indefinitely?) and demo-visit
   logs.

## 5. Updated cutover checklist

`docs/live-cutover.md` is updated:
- **Stage 0 (new): legal groundwork.** LIA, ICO registration, privacy notice, demo-page privacy line, and
  a solicitor's read of the claim terms.
- **Stage 1: v2 runtime.** D1 migrations 0010–0013; queues and dead-letter queue; Durable Objects and
  the Workflow; Runtime health and Budgets checks; a forced dead letter.
- **Stage 3: `MODEL_LIVE`.** Plus the Anthropic key on the Worker.
- **Stage 4: change feed.** `CH_STREAM_KEY` as a Worker secret, verifying the stream fields the trigger
  rules use, and reading `triggers.json`.
- **Stage 6: sending-domain warm-up.** Plus a note on the holdout.
- **Stage 6b (new): claim this site.** Stripe test mode; the four webhook events; building and verifying
  the subscription call; the test-mode live runs (pay, details, approve, replay, cancel, your minutes).

## 6. What happens next

Nothing, until you say. Milestone B (golden sets, earned autonomy, opportunity cards, brain PRs, the
loop) stays frozen until real outcomes exist. When you're ready, the useful order is:
- cutover Stages 0–5 (which you're running in parallel);
- then 6 and 6b;
- then a decision on Milestone B once there are a few weeks of real ledger rows.

Every commit is on `claude/nifty-curie-91l1nq`.
