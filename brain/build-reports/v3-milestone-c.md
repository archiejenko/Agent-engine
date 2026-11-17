---
type: build-report
milestone: v3-C
date: 2026-11-17
status: STOPPED — waiting for Archie
---

# v3 Milestone C: stop-point report

Milestone C (v3 Phases 1–5) is built: the internal dashboard over the existing data. Every gate passes on
synthetic data, with fakes, with the kill switch on and Stripe in test mode. Nothing external happened.
**I've stopped here, as planned.** Milestone D (Phases 6–10: agents and autonomy) waits for your go-ahead.

## 1. Gate results

| Phase | What it is | Gate | Report |
|---|---|---|---|
| 1 | Shell (Home, Ideas, Board, Vault, CRM, Inbox, Controls), Home figures, CRM | **4/4 passed (synthetic)** | `brain/build-reports/v3-phase-1.md`, `docs/gates/v3-phase1.md` |
| 2 | One Needs-you queue with safe defaults, the daily digest | **5/5 passed (synthetic)** | `v3-phase-2.md`, `docs/gates/v3-phase2.md` |
| 3 | Inbox, the mailbox port (read and draft, no send), Email Routing handler, mailbox MCP endpoint | **3/3 passed (synthetic)** | `v3-phase-3.md`, `docs/gates/v3-phase3.md` |
| 4 | Vault: search, backlinks, versioned edits, agent provenance, the ideas sheet (assumed) | **5/5 passed (synthetic)** | `v3-phase-4.md`, `docs/gates/v3-phase4.md` |
| 5 | Controls → Keys: write-only keys, injection at the tool boundary, leak test, failing key pauses only dependants | **5/5 passed (synthetic)** | `v3-phase-5.md`, `docs/gates/v3-phase5.md` |

Run any gate again with `pnpm gate:v3 --phase N`.

**Tests:**
- `pnpm check` is green: typecheck (including the Worker's), lint, and **392 tests in 53 files**.
- Every gate also runs in CI.
- The Worker builds with every binding (`wrangler deploy --dry-run`).
- The phone layout test covers every page and tab at 390px and 1440px.

**v3 rules, each enforced in code with a test:**

| Rule | Where it's enforced | Test |
|---|---|---|
| 18 One decisions queue | every approve button goes through `decide()`; only `decisions.ts` creates owner approvals | gate 2 + static test |
| 19 Safe defaults spend and send nothing; recorded as "defaulted" | `expireDecisions` applies the default with no approval | gates 2 and 5 |
| 20 Keys are write-only | `keys.ts` is the only reader; values scrubbed; status-only table | gate 5 (leak test) + static tests |
| 21 Agents write the Vault as new versions with provenance | `note_versions` append-only; `writeAgentNote` refuses without provenance | gate 4 |
| 22 The holdout stays hidden | blind serializers on CRM, Inbox, the queue and the digest | gates 1–3 |
| 23 Assumed numbers stay assumed | every tile labelled; ideas sheet labelled assumed and never read by scoring | gates 1 and 4 + static test |

**Constraints from your brief, all kept:**
- No landing page, sign-up or waitlist. The root URL is the dashboard. Public routes are unchanged, and
  `/thanks` is still flagged.
- No cookie banners, consent flows or new legal pages.
- No new vendors or frameworks.
- Every v1 and v2 guardrail test still passes.

## 2. Unverified adapters (built to the docs or to a port, not yet run live)

| Adapter | Why it's unverified | What verifies it |
|---|---|---|
| **Mailbox MCP endpoint** (`POST /api/mcp/mailbox`) | the MCP spec site was blocked from this build | connect one MCP client to it at cutover; until then it's only reachable from inside the Access-protected dashboard |
| **Email Routing handler** (`email()` in the Worker) | built to the current Cloudflare docs; never received a real email | cutover Stage 1c: send a test email to the reply address |
| **Secrets Store list call** (finds an existing secret's ID) | its response shape isn't shown in the docs; create and replace follow the docs exactly | cutover Stage 1b: the first save on the Keys page |
| **Stripe subscription call** (from Milestone A) | Stripe docs blocked; the real call still **refuses to run**; event field names marked UNVERIFIED | allow `docs.stripe.com` for a session, or paste the four pages (see the Milestone A report) |
| **Companies House stream** (from Milestone A) | docs blocked; polling does the work until `CH_STREAM_KEY` is set | cutover Stage 4 |
| **Claude client** (from v1) | built to SDK 1.6.0's types; never called with a real key | cutover Stage 3 (`MODEL_LIVE` = "1" plus the key on the Keys page) |

## 3. Every config value you need to set

Milestone A's list still stands: priors, holdout share, letter EV, caps, spend tiers, sender details,
claim prices and terms, and triggers (`brain/build-reports/v2-milestone-a.md`, section 3). Milestone C adds:

**`packages/config/src/infra.json` → `owner`**

| Value | Now | What sets it |
|---|---|---|
| `hourly_gbp` | 40 | your real hourly value (decision D2). It drives "your time" costs on Home and stays labelled **assumed** until you change it |

**`packages/config/src/decisions.json`** (how long each decision waits before its safe default)

| Value | Now | |
|---|---|---|
| `deadline_hours.lead` / `print_batch` | 168 / 168 | a week |
| `deadline_hours.draft` | 72 | three days, then the draft is cancelled (not sent) |
| `deadline_hours.claim_publish` | 120 | five days, then "not yet" |
| `deadline_hours.uncertain_effect` / `dead_letter` | 336 / 336 | two weeks |
| `deadline_hours.data_conflict` / `quarantine` | 720 / 720 | a month |
| `deadline_hours.spend_tier` / `autonomy` | 72 / 72 | |
| `deadline_hours.key_failing` | 168 | the dependants stay paused regardless |
| `max_open_leads` | 50 | how many lead decisions sit in the queue at once |
| `digest_hour_utc` | 6 | when the daily digest is written |

**`packages/config/src/keys.json`** lists six keys and the playbooks that depend on each:
`ANTHROPIC_API_KEY`, `CH_API_KEY`, `CH_STREAM_KEY`, `EMAIL_API_KEY`, `STRIPE_SECRET_KEY` (test mode only),
`STRIPE_WEBHOOK_SECRET`. Check that the dependants match how you want pauses to work.

**`apps/api/wrangler.jsonc` and Cloudflare**

| Value | Kind | |
|---|---|---|
| `ACCESS_TEAM_DOMAIN`, `ACCESS_POLICY_AUD` | vars (already there, empty) | your Access app |
| `CF_ACCOUNT_ID`, `SECRETS_STORE_ID` | vars (new) | for saving keys from the dashboard |
| `CF_SECRETS_TOKEN` | Worker secret (the one you set by hand) | a token with **Account Secrets Store Edit only** |
| `secrets_store_secrets` block | bindings | snippet in `docs/runbooks/keys.md` |
| the reply address | Email Routing | e.g. `replies@<sending domain>` routed to the Worker (decision D1) |

**Files only you can write:**
- `brain/ideas/seed-500.csv`, your 500 scored ideas. The Vault shows it with every score labelled
  assumed. The page tells you if it's missing.
- `brain/status-and-vision.md` is a stub marked "To write (Archie)".

## 4. Updated cutover checklist

`docs/live-cutover.md` now has:

- **Stage 1, v3 dashboard:**
  - D1 migrations 0014–0017 (`/api/health` shows 17);
  - the root URL opens the dashboard;
  - Needs you and the digest;
  - the Vault bundle, and adding the ideas sheet.
- **Stage 1b, Keys (new):**
  - create the Secrets Store and the narrow token;
  - set the vars and bindings;
  - make the first save on the Keys page, which verifies the list call;
  - from then on, keys go in through the Keys page.

  The runbook is `docs/runbooks/keys.md`.
- **Stage 1c, Replies inbox (new):**
  - the dedicated reply address, routed to the Worker by Email Routing;
  - a test email;
  - check the sending provider's terms allow B2B cold outreach before adding `EMAIL_API_KEY`.
- **Stage 1d, GitHub settings (new, manual, decision D5):**
  - **CODEOWNERS** on the safety-layer files (listed in the checklist);
  - **branch protection** on `main`: pull request, code-owner review, CI, no force push, **no auto-merge**;
  - the conditions if Claude Code ever runs from GitHub: only from your label or comment, never on a
    schedule.

## 5. Things to know

- **Keys moved behind the key ring.** The Worker now reads the Claude, Companies House and Stripe keys
  through it. Existing Worker secrets keep working as a fallback, so nothing breaks if you set keys the
  old way first.
- **A key a provider refuses** pauses only the playbooks that use it, and asks you in Needs you. Saving a
  new key resumes them.
- **Vault edits.** An edit made on the dashboard lives in D1 until it's committed to `brain/`. The page
  labels it.
- **Ideas and Board** are placeholders until Milestone D (Phase 6).

## 6. What happens next

Nothing, until you say. Milestone D (v3 Phases 6–10: idea cards and the Board, agents proposing work,
earned autonomy, brain pull requests, the loop) waits for your approval. Cutover Stages 0–5 can carry on
in parallel. The new Stages 1b–1d are quick and unblock the inbox and keys.

Every commit is on `claude/nifty-curie-91l1nq`.
