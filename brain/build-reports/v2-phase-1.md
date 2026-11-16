---
type: build-report
phase: v2-1
date: 2026-11-16
status: gate passed (synthetic)
---

# v2 Phase 1 — outcome ledger, holdout, EV gate (gate report)

## Revised effort estimate per phase (you asked for this at the top)

Phase 1 was mostly **extension**: the `outcomes` table, cohorts on top of existing intake, and new
reports over data we already had. Phases 2 and 3 are mostly **new builds** (Queues, Workflows, Durable
Objects), where the risk sits in Cloudflare behaviour we can only partly test locally. Measured in
build sessions like this one (one session ≈ one long working block, with its tests and report):

| Phase | What it is | Kind | Estimate | Main risk |
|---|---|---|---|---|
| 1 Ledger, holdout, EV gate | extend `outcomes`, cohorts, priors, demo instrumentation, economics | mostly extension | **1 session (done)** | none left; numbers are placeholders until real outcomes |
| 2 Workers runtime | Cron, Queues + dead-letter queue, a Workflow engine (Cloudflare adapter + a local runner with persisted steps), recorded external effects, change-feed Durable Object with polling fallback, trigger rules, health page | **new build** | **2–3 sessions** | Workflows and Queues can't be fully exercised in Node tests; I'll test the logic through a local runner with the same step contract and run one `wrangler dev` smoke test |
| 3 Hard budgets | Budget Durable Object (reserve / settle / release), S-tiers with recorded approvals, weekly explore share | **new build** (smaller) | **1–1.5 sessions** | proving "50 parallel reservations can't exceed a cap" needs the DO's single-threaded storage; tested against a faithful in-memory version plus one `wrangler dev` run |
| 4 Claim this site | Stripe test-mode subscription checkout (setup fee + monthly), webhooks, fulfilment Workflow, `post_reply` playbook at L0, terms wording | extension of payments + new workflow | **2 sessions** | consumer cancellation wording needs your legal answer (in the Milestone A report) |
| Milestone A report | gate results, config values that need real numbers, legal questions, updated cutover checklist | writing | **0.5 session** | — |

**Total remaining for Milestone A: about 6–7 sessions.** Per-playbook evals are Milestone B (frozen), so
they're not in this total.

---

## What was built

**Outcome ledger.** The existing `outcomes` table was extended in place (migration 0010; the backtester
still works). Every event carries its task, playbook version, cohort and arm, experiment slot, a £ value
(actual for money events, otherwise an *estimate with its assumption written next to it*), time on page,
`synthetic` and `dry_run` flags, and a dedupe key so a retry never double-counts. The events written
today:

| Event | Where it's recorded |
|---|---|
| `sent` (email) | the `send_email` tool, once per email (dry runs are flagged `dry_run`) |
| `sent` (letter) | approving a print batch: one per approved letter |
| `qr_scan`, `demo_visit` | serving a live demo page (`?s=qr` on the printed QR code tells a scan from a typed link) |
| `reply`, `reply_positive` | the inbox loop, attributed to the task that sent the original email |
| `booking`, `paid`, `refunded`, `churned` | entered by hand on `POST /api/ledger` for now; Stripe writes `paid` from Phase 4 |

**Cohorts and the holdout (decision D4).** Each intake of approved outreach leads opens a cohort with a
recorded seed. Ranked leads go through the same compliance checks as before, then the EV gate. A random
holdout of `ranked × h / (1 − h)` companies (h = 15%) is then drawn from the eligible universe, by the
seed. The holdout gets the same playbook for its channel and **passes the same compliance checks**. The
EV gate isn't applied to it, otherwise it wouldn't be random. Holdout drafts are **blind** in Review: the
list shows only the company number, and a waiting task hides its reference, idempotency key and arm.
Lift is measured on **assignment** (intent to treat), with a 95% interval. Drafts you rejected are
reported separately.

**P(paid) and the EV send gate.** P(reply) and P(paid | reply) start from priors in config, all labelled
as assumptions: 3% reply, 15% close, £1,500 first-year value, worth 20 sends. They move towards real
rates as sends accumulate (Beta-binomial). They read **only** the ledger, and only rows that are real
(`synthetic = 0`), not dry runs, and recorded before the as-of time.
- **Letters** go only when EV ≥ 3 × the letter's cost. With the priors, EV is
  0.03 × 0.15 × £1,500 − £0.99 = £5.76, against a threshold of 3 × £0.99 = £2.97.
- **Email** goes when EV > 0.

**Demo pages.**
- The page records that it was opened, whether by QR or link, and how long it was visible.
- **No cookies, no IP address, no user agent.**
- One inline script, allowed by its hash in the Content-Security-Policy, which may only talk back to our
  own server.
- A privacy line has been added to the page footer.

**Unit economics and your minutes.** Per playbook (and per experiment, from Phase 3) the system shows
model cost, send cost (print and postage, plus real emails), revenue, margin and **your minutes**.
- The dashboard times each review decision, counting only time the page was visible.
- A print batch's time is split across its letters.
- These figures appear on Metrics as "Ranked leads against a random holdout" and "Unit economics", with
  an "Include simulated rows" switch that labels everything SIMULATED.

**Truthful labelling (rule 15).** Both writer prompts now say the message is a sales approach. The checker
rejects any draft that poses as a survey, research or a personal note. The phrase list is in config.

**Simulator.** `AgentService` takes `synthetic: true`. Every task, outbox row, letter, ledger row and
review session it creates is then marked synthetic. The Phase 1 gate runs through it in a sandbox database.

## Changes in behaviour you should know about

1. **A company that asked for no more letters is now not contacted by email either.** Before, its
   suppression only stopped letters. "One global suppression list" should mean any channel, and the gate
   caught a holdout email going to such a company. Logged in `docs/decisions.md`.
2. **Leads at an accountant's or formation agent's registered office are now skipped at intake**, not
   just flagged in the print batch. We hold no trading address for them, and a letter there rarely
   reaches the directors. This is a config switch (`measurement.skip_flagged_registered_offices`), and the
   skip is listed in the cohort with its reason. The Phase 5 gate was updated to expect this.
3. **Holdout tasks appear in Review and the print batch alongside ranked ones**, about 15% extra volume.
   That's the cost of being able to say whether ranking works.

## Gate (docs/gates/v2-phase1.md)

Run with `pnpm gate:v2-phase1`: 1,023 synthetic companies, 20 email leads and 12 letter leads approved.

| Criterion | Status |
|---|---|
| Every outreach intake is a cohort: ranked + random holdout at the configured share | passed (synthetic) |
| The holdout draw is random but reproducible from its recorded seed | passed (synthetic) |
| Holdout sends pass the same compliance checks | passed (synthetic) |
| Blind review: holdout drafts are indistinguishable from ranked ones | passed (synthetic) |
| Outcome ledger: sent, QR scan, demo visit (+ time on page), reply, paid — each attributed | passed (synthetic) |
| Demo pages: no cookies/IP/device details; one hashed script; privacy line | passed (synthetic) |
| Synthetic data never trains anything; reports show it only when asked, labelled | passed (synthetic) |
| Lift on assignment with a 95% interval; no claim without paid outcomes | passed (synthetic) |
| Unit economics per playbook incl. your minutes | passed (synthetic) |

**Tests:** `pnpm check` is green: typecheck, lint and 356 tests in 41 files. The new guardrail tests are
in `packages/infra/src/__tests__/v2-measurement.test.ts`:
- synthetic and dry-run rows never move P(paid);
- point-in-time (outcomes after as-of are ignored);
- your approvals, edits and review time never change P(paid), checked by behaviour and by a static check
  over the scoring and targeting code;
- the EV gate;
- seed reproducibility;
- holdout size;
- the lift interval;
- truthful labelling;
- demo page instrumentation.

The simulator gate also runs in CI at a small size (`apps/api/src/gates/v2-phase1.test.ts`).

## Placeholders that need real numbers (collected again in the Milestone A report)

| Config (`packages/config/src/infra.json` → `measurement`) | Now | What would set it |
|---|---|---|
| `priors.reply_rate` | 0.03 | your first 100–200 real sends |
| `priors.close_rate` | 0.15 | your own history of replies that turned into paid work |
| `priors.first_year_value_gbp` | 1500 | the claim-this-site price (setup + 12 × monthly) once you set it in Phase 4 |
| `priors.strength` | 20 | how much to trust the prior; 20 = "as much as 20 real sends" |
| `holdout_share` | 0.15 | 10–20% allowed; higher gives an answer sooner but costs more sends to random companies |
| `letter_ev_k` | 3 | how much better than break-even a letter must look |
| `email_send_cost_gbp` | 0.001 | your sending provider's real per-email price |

## Not done in Phase 1 (by design)

- Stripe writes `paid` automatically from Phase 4 (claim this site). Until then, enter it on
  `POST /api/ledger`.
- No per-lead adjustment of P(paid) yet. It's one estimate per playbook until outcomes can support more.
- Nothing learns yet. The estimates move as real outcomes arrive, but weights don't change; that's
  Milestone B.

Next: Phase 2 (Workers runtime).
