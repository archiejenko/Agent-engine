---
type: build-report
phase: v2-4
date: 2026-11-16
status: gate passed (synthetic, test mode)
---

# v2 Phase 4: claim this site, fulfilment, post-reply (gate report)

## In one paragraph

A company that likes its sample page can now click **"Like it? Claim this site"** and do three things:
- read the price and the terms;
- pay a **setup fee plus a monthly subscription** through Stripe (test mode only);
- get its site built.

The build runs as a **fulfilment workflow**:
1. Email the customer a private details form, then wait up to 14 days.
2. Draft the site **only from what they sent**.
3. Wait for **your approval** on the dashboard.
4. Publish it.
5. Email them an offer to connect their own domain.

If they cancel or are refunded at any point, fulfilment stops at its next step and the site comes down.

Every payment, renewal, cancellation and refund lands in the outcome ledger, **attributed to the letter
or email that earned it**. That's what lift and margins will be measured on.

Separately, replies to our outreach now get a **post-reply** draft: triage happens in code, the model
drafts an answer, and it waits for your review. Nothing is sent, because it's L0.

## What was built

| Part | Where |
|---|---|
| Claim page, terms (draft), form → subscription checkout | `/claim/:slug`, `POST /public/claim/:slug`, `startClaim` |
| "Claim this site" link on every live sample page | `instrumentDemoHtml` |
| Stripe subscription events → claim, ledger, workflow (idempotent) | `handleClaimEvent`: paid, renewal, cancelled (churned), refunded |
| Fulfilment workflow `claim_fulfilment` + playbook spec `claim_site` (L0) | `packages/infra/src/claim.ts`, `playbooks/claim_site/SKILL.md` |
| Workflow "wait for event" (details form, your approval, cancellation) | `waitForEvent` in both engines (Cloudflare `step.waitForEvent`, local events table) |
| Customer tools: `send_customer_email`, `publish_site` (operator only, recorded before they run) | `registerClaimTools` |
| Details form and the live site | `/claim/details/:token`, `/s/:slug` |
| Dashboard: Claimed sites (draft, Approve / Not yet, your minutes vs the 30-minute target) | Letters page → Claimed sites |
| `post_reply` playbook (L0): code triage → draft (their message is untrusted) → checks → your review | `playbooks/post_reply`, `packages/infra/src/playbooks/post_reply.ts` |
| Test mode only (rule 9) | a live Stripe key switches card payments off |

## Gate (docs/gates/v2-phase4.md): `pnpm gate:v2-phase4`

| Criterion | Status |
|---|---|
| End to end in test mode: sample → checkout (setup + monthly) → paid → details → draft → approved → live → domain proposal | passed (synthetic) |
| Ledger attribution: checkout_started, paid (setup + first month) and the renewal → the letter that earned them | passed (synthetic) |
| Webhook replay doesn't double-fulfil | passed (synthetic) |
| Cancellation (opt-out) stops fulfilment within one step; refund recorded | passed (synthetic) |
| post_reply at L0: triaged, checked draft for review; nothing sent; the reply's instructions are ignored | passed (synthetic) |
| Stripe test mode only; the unverified real subscription call refuses to run | passed (synthetic) |
| Your minutes per site against the target | passed (synthetic) |

**Tests:** `pnpm check` is green: 373 tests in 46 files. The Worker builds with all bindings.

**Fixes the gate drove:**
- A tool that refuses **before** acting (for example, trading details still placeholders) used to be
  logged as "outcome unknown", which then blocked every retry. Tools now signal "didn't happen" in that
  case. Errors after acting still need a person to check.

## What's NOT done, and why

1. **The real Stripe subscription call isn't built, and Stripe's event field names aren't verified.**
   Stripe's docs were blocked from the build environment, and the rule is not to write API calls from
   memory. The real `createSubscriptionCheckout` **refuses to run**. Field names in
   `toSubscriptionEvent` are clearly marked UNVERIFIED. To finish it, either:
   - allow `docs.stripe.com` for a session; or
   - paste the Checkout Sessions (subscription mode), Invoice, Subscription and Charge docs.
2. **The terms are a draft.** The wording in `products.json` → `claim_site.terms` needs your solicitor's
   eye. The questions are in the Milestone A report.
3. **Hosting is minimal.** A published site is a simple page at `/s/:slug` built from their details. A
   proper template, images and the custom-domain set-up are later work (the domain is a proposal email
   for now).

## Config values that need real numbers (`products.json` → `claim_site`)

| Value | Now | |
|---|---|---|
| `setup_fee_gbp` | 149 | placeholder |
| `monthly_gbp` | 15 | placeholder |
| `details_wait_days` | 14 | how long to wait for their details form |
| `publish_wait_days` | 30 | how long a draft waits for your review |
| `human_minutes_target` | 30 | your minutes per site before it shows red |
| `base_url` | https://sites.ejtech.example | placeholder (D6): becomes a subdomain of ejtech.co.uk that never sends email |
| `terms`, `terms_version` | draft-2026-11-16 | needs legal review |

Next: the Milestone A report, then stop.
