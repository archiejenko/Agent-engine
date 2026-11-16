# Progress (for resuming in a new session)

Read `CLAUDE.md`, then this file, then `docs/live-cutover.md`.

**v2 (2026-11-16):** the 2026-11-10 freeze is lifted for **v2 Milestone A only** (dry-run). Milestone B stays frozen until real outcomes exist. Plan and gate reports: `brain/build-reports/`. Archie runs cutover Stages 1–5 in parallel. **Milestone A is done and the build is STOPPED** at `brain/build-reports/v2-milestone-a.md`, waiting for Archie.

**Status:** keyless build of Phases 0–5 COMPLETE, plus the 2026-11-09 pre-cutover changes (official x402 middleware, 90-day website shelf life, `sme_letter`). Next: live cutover (`docs/live-cutover.md`, ordered by time to cash), led by Archie.

**Mode:** keyless build of Phases 2–5 (approved 2026-11-08). No gate stops; synthetic gate report per
phase; commit + push per phase with CI green. Branch: `claude/nifty-curie-91l1nq`.

| Phase | Status |
|---|---|
| 0 Foundations | built; Cloudflare deploy live-pending |
| 1 Verification on open data | built; synthetic gate passed; live run pending |
| 1b Archie's changes (period-dated facts, header rate limiter, streaming plan) | done |
| 2 Lead gen to drafts | built; synthetic gate passed (`docs/gates/phase2.md`); live pending |
| 3 Measurement | built; synthetic gate passed (`docs/gates/phase3.md`); live pending |
| 4 x402 check | built; synthetic gate passed (`docs/gates/phase4.md`); live pending |
| 5 Alerts, human check, autonomy | built; synthetic gate passed (`docs/gates/phase5.md`); live pending |

## Log
- 2026-11-08: period-dated facts (no decay), header-driven rate limiter, Phases 2–5 plan written.
- 2026-11-08: Phase 2 checkpoint — ports package (model/web/email/queue fakes; real Anthropic adapter at @ae/ports/anthropic), models.json, migration 0003, website ingestion with guardrail tests.
- 2026-11-08: Phase 2 complete — signals, framework note, module runner, explanations, review queue (API + dashboard), tasks/tool registry/controls/runner, sme_outreach L0, agent runner service, real web adapters; gate passed on synthetic data.
- 2026-11-08: Phase 3 complete — golden set + accuracy/calibration, drift monitoring with source pause, human override, outcomes API, backtester with look-ahead guard, pilot→live promotion, weight suggestions (accept/reject), digests + margin report, nightly re-verification, Metrics + Golden dashboard pages; gate passed on synthetic data.
- 2026-11-08: Phase 4 complete — company check product (open lane only, per-field confidence, risk flags), x402 v2 gate (verify → work → settle), fake + real facilitators, premium live re-check, request log + payments ledger, x402_discovery module, blind verifier with adaptive sampling, Streaming API consumer (fake + real); gate passed on synthetic data.
- 2026-11-08: Phase 5 complete — watches + change alerts (webhook/email, idempotent), human report via Stripe Checkout (webhook signature check, idempotent), sme_outreach at L1 with send under guardrails (role address on own domain, company-type rule, suppression list incl. domain, sender identity + opt-out, follow-ups), inbox processing (replies stop follow-ups, opt-outs suppress), autonomy stats/suggestions + demotion on breach, Controls dashboard page, bundled playbooks for the Worker, Stripe wired in the Worker behind secrets + kill switch; gate passed on synthetic data.
- 2026-11-09: pre-cutover changes — x402 on the official @x402/hono middleware (verify → handler → settle on success), fake facilitator with nonce + validity-window checks, EIP-712 domain in config; site-level website facts hold 90 days (Phase 2 gate rerun); new `sme_letter` playbook (L0): demo homepage (noindex) + print-ready PDF letter with QR, weekly print batch approval, accountant-address flags, letter opt-outs; Claude adapter sends fallbacks only where supported; live-cutover reordered by time to cash.
- 2026-11-09: sme_letter additions — fixed "Sample prepared by EJTECH Ltd, not affiliated with <company>" banner, no imagery (test + CSP), demo pages expire 30 days after batch approval (410 "This sample has expired."), one-line opt-out on every letter (reply email quoting a code, or short URL /stop/<code>) feeding the shared suppression list.
- 2026-11-10: screenshot-review fixes — trading disclosures on every outbound template (tested), copy rules in prompts v2 + checker, 90-day per-company contact cooldown across email/letters, print+postage in letter task cost (outside the daily caps), SIC-based demo copy, drift (3 complete runs, partial runs ignored, resume closes alert), x402_discovery read-only, dashboard mobile/tabs/labels/empty states/Controls banner with a Playwright no-sideways-scroll test in CI; gates 1–5 rerun; screenshots re-captured (docs/screens).
- 2026-11-10: last pre-cutover fixes — cooldown shown on leads (approve disabled with dates), one daily digest alert for blocked duplicates, Overview "Today" panel; then feature freeze.
- 2026-11-16: v2 plan approved (D1–D7); Milestone A build started.
- 2026-11-16: v2 Phase 1 gate passed (synthetic): outcome ledger, cohorts + blind holdout, EV gate on priors, demo-page visits, unit economics with review minutes. Report: brain/build-reports/v2-phase-1.md.
- 2026-11-16: v2 Phase 2 gate passed: Workers runtime (cron → queue + DLQ, workflow engine, recorded external effects, change-feed DO with polling fallback, trigger rules, health page). CH streaming adapter deferred (docs blocked). Report: brain/build-reports/v2-phase-2.md.
- 2026-11-16: v2 Phase 3 gate passed: reserve/settle budgets in a Durable Object, S-tiers and L3 behind recorded owner approvals, weekly explore share. Report: brain/build-reports/v2-phase-3.md.
- 2026-11-16: v2 Phase 4 gate passed (test mode): claim this site (setup + monthly), fulfilment workflow with details form and publish approval, replay/cancel safety, post_reply (L0). Real Stripe subscription call deferred (docs blocked). Report: brain/build-reports/v2-phase-4.md.
- 2026-11-16: **v2 Milestone A complete — STOPPED for Archie.** Report: brain/build-reports/v2-milestone-a.md (gates, config values needing real numbers, legal questions, updated cutover checklist). Milestone B frozen.
