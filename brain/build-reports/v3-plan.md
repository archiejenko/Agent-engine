---
type: build-report
milestone: v3-plan
date: 2026-11-16
status: waiting for Archie's approval (no code written)
---

# Agent Engine v3: plan (internal dashboard and judge-only autonomy)

**No v3 code has been written.** This is step 0: the audit, the old → new page mapping, schema changes,
risks, effort, and my recommendation on each decision. When you approve, I build Milestone C (Phases 1–5)
without stopping and then stop at the Milestone C report.

Starting point: branch `claude/nifty-curie-91l1nq` at `b7f2ad5`. Milestone A is complete, `pnpm check` is
green (374 tests), CI is green, and nothing is deployed.

---

## 1. Audit: what exists, per phase

### Milestone C

| Phase | Item | Status | What's there today |
|---|---|---|---|
| 1 Shell | Navigation | partial | 7 tabs (Overview, Review, Letters, Facts, Metrics, Golden set, Controls) in a hash router (`App.tsx`). Needs regrouping into Home, Ideas, Board, Vault, CRM, Inbox, Controls. |
| 1 Shell | Phone layout test | **exists** | `tests/mobile-layout.test.ts` checks every page at 390 px and 1440 px, seeded and empty, for zero sideways scroll. The page list needs updating. |
| 1 Home | Analytics | partial | `/api/today` (drafts waiting, letters, conflicts, 7-day revenue/cost/margin), `/api/overview`, `/api/metrics`, `/api/lift`, `/api/economics` (cost, revenue, margin, minutes). Missing: MRR, pipeline value, reply rate, CAC, cost to serve, the real/estimated/synthetic label on every tile, date-range and playbook filters, one ledger-reconciled source. |
| 1 CRM | Company list and stages | partial | Facts search (`/api/facts`), Company page (facts, claims, conflicts), `outcomeLedger`, `outbox`, `letters`, `suppressions`, `siteClaims`, `cohorts` all exist. Missing: a stage per company, expected value, last contact, next step, owner agent, filters and export. Stage can be **derived** from existing tables, so no new table is needed. |
| 1 CRM | Holdout stays hidden | **exists** (pattern) | `blindTask` hides the arm in Review. Needs to become one shared serializer used by CRM and Inbox, with a test. |
| 2 Queue | One decisions queue | partial | Approvals today come from **9 separate places**: task drafts, lead approvals, print batches, claim publish, spend tiers / L3 (`owner_approvals`), uncertain external effects, dead letters, fact conflicts, quarantine. There's no `decision` record, ranking, deadline or safe default. |
| 2 Queue | Recorded-approval path | **exists** | `owner_approvals` (single use, Access identity recorded, created only by the dashboard API; a static test enforces this). It's extended to cover every decision. |
| 2 Digest | Daily digest | partial | `scripts/digests.ts` (weekly, Node, writes `brain/digests/`). Missing: a daily digest built on Workers and shown on the dashboard. |
| 3 Inbox | Outbound drafts / sent / replies | partial | `outbox` (sent, dry runs, blocked), drafts awaiting approval (tasks), the `Inbox` port (poll only) and `FakeInbox`, the `post_reply` playbook, letters and print batches. Missing: a `MailboxPort` (list, read, draft), stored replies, and the three tabs. |
| 3 Inbox | Mailbox MCP server for agents | missing | No MCP code. The MCP spec site is **blocked** from this environment (checked). See decision 6. |
| 4 Vault | Browser over `brain/` | missing | `brain/` has 2 frameworks, `taxonomy.md`, build reports, and empty `digests/` and `signals/`. No search, tags, backlinks or versions. **`brain/status-and-vision.md` is missing** (you said you'd add it; I'll create a stub and mark it "to write"). |
| 5 Controls | Kill switches, budgets, runtime health | **exists** | Controls page (Budgets, Runtime health, Claims are there now). |
| 5 Keys | Write-only keys, injected at the tool boundary, failure pauses dependants | missing | Keys are Worker secrets read directly in `worker.ts` / `runtime-worker.ts`. There's no registry, status page or leak test. |

### Milestone D (summary; planned in detail at the Milestone C stop)

| Phase | Status | Notes |
|---|---|---|
| 6 Ideas, Board, research agents | partial | The opportunity engine (`runModule`, framework notes, traced scores), `taxonomy.md`, and the trigger rules plus change feed (the "scout" input) exist. Missing: idea cards, planner, threads, hypothesis backlog, Board. |
| 7 Standing rules, sampling | partial | Autonomy levels with auto-demotion, `approvals` and `examples` (raw material for the golden set), recorded approvals. Missing: rule records, sampling, the margin-window fix, playbook golden cases and hidden cases. |
| 8 Coordinator, operations agent, circuit breakers | partial | Workflows engine, dead letters, recorded effects, health page and kill switches exist. Missing: the coordinator Workflow, the ops agent, rate-based breakers. |
| 9 Hands-off delivery | partial | Claim fulfilment workflow, `post_reply`, `checkSiteDraft`. Missing: pre-publish site checks (links, forms, mobile), support agent, print and domain ports. |
| 10 Money, self-improvement, x402 deploys | partial | Run-log costs, `unitEconomics`, payments ledger, `weights suggest`, x402 Worker. Missing: full vendor cost ledger, credit tracking, reinvestment rule, CSV export, bot PRs and path allowlist, deploy tasks, the weekly/monthly loop. |

### Landing or marketing pages

**None found.** The dashboard's `index.html` is the app shell. The root URL already serves the dashboard
behind Cloudflare Access (static assets). The Worker has no `/` route and no marketing, sign-up or
waitlist page.

The public routes are exactly the ones outreach and payments depend on, and **they stay unchanged**:
- `/demo/*` (sample pages) and `/stop/*` (opt-out);
- `/claim/*`, `/public/claim/*` and `/s/*` (claim this site and published customer sites);
- `/public/checkout` and `/webhooks/stripe` (payments);
- `/x402/*` (paid company checks).

One loose end, flagged but **not changed** because it's on a frozen path: the one-off checkout for the
human report and monitoring sends customers to `/thanks`, which has no route.

---

## 2. Page mapping: old → new

| Old page or panel | New home | How |
|---|---|---|
| Overview (data counts, "Today" panel) | **Home** | Data counts → a small "Data" strip. "Today" → the Needs-you queue preview and the digest. |
| Metrics (lift, unit economics, verification accuracy, calibration, backtests, drift, pauses) | **Home** | Money and lift go on the main tiles. Verification quality goes in a "Quality" section lower on Home. |
| Facts (search, list) | **CRM** | The company list *is* the facts search, plus stage, value and contact columns. |
| Company page | **CRM → company view** | Adds the contact history, ledger events, opt-out status and claims. |
| Review → leads to approve | **Needs you** (decision `lead`) | |
| Review → email drafts | **Inbox → awaiting approval** | A filtered view of the queue. The approval itself is a decision, so there's no separate list. |
| Review → conflicts, quarantine | **Needs you** (decision `data_conflict` / `quarantine`) + CRM company view | |
| Letters → print queue | **Inbox**, letters filter | Approving a batch is a decision. |
| Controls → Claims | **CRM** (stages claimed / customer) | Publishing is a decision. |
| Golden set (hand-verify companies) | **CRM → "Verify" tab** | Each due batch appears in Needs you as one decision ("verify 10 companies, about 15 min"). |
| Controls → kill switches, budgets, runtime health | **Controls** (unchanged), plus **Keys** | Uncertain actions and dead letters move to Needs you. |
| — | **Ideas**, **Board** | Placeholders in Milestone C; built in Phase 6. |
| — | **Vault** | Phase 4. |

Old hash links (`#/review`, `#/letters`, `#/facts`, `#/metrics`, `#/golden`) will redirect to their new
place, so nothing you've bookmarked breaks.

---

## 3. Schema changes (Milestone C)

The existing names win; nothing is renamed. All migrations are plain SQL, tested on SQLite and D1.

| Migration | Contents |
|---|---|
| `0014_v3_decisions.sql` | **`decisions`**: id, type, source_ref, summary, money_at_stake_gbp, options (json), recommended, safe_default, deadline, status (`open` / `decided` / `defaulted` / `superseded`), chosen_option, approval_id, synthetic, created_at, decided_at. Plus a unique open decision per (type, source_ref), so the same thing can't be queued twice. **`owner_approvals` is rebuilt** (SQLite can't change a CHECK constraint) to add `kind = 'decision'` and a `decision_id`. Every decision you make writes one approval through the existing single path. **`digests`**: day, body (json), created_at. |
| `0015_v3_vault.sql` | **`note_versions`**: id, path, version, title, body, tags (json), author (`archie` / agent name / `git`), provenance (json: sources, ledger rows, flags `licensed` and `untrusted`), created_at. Append-only, so the newest version wins and nothing is overwritten. |
| `0016_v3_mailbox_keys.sql` | **`mail_messages`** (the mailbox store behind the fake and the future inbound route): id, folder (`inbox` / `drafts` / `sent`), thread_id, from, to, subject, body, entity_id, task_id, untrusted, received_at. **`key_registry`**: name, status (`unset` / `ok` / `failing`), last_used_at, last_ok_at, last_error, used_by (json), updated_at. **It never stores a value.** |

The CRM needs **no table**: its stage, expected value, last contact and next step are derived in code
from `outcomeLedger`, `outbox`, `letters`, `suppressions`, `siteClaims`, `opportunities` and `tasks`.

---

## 4. New files (Milestone C)

**API**
- `apps/api/src/routes/home.ts` (one ledger-reconciled analytics endpoint)
- `crm.ts`, `decisions.ts`, `inbox.ts`, `vault.ts`, `keys.ts`

**Domain code** (`packages/infra/src/`)
- `decisions.ts`: create, rank, decide, expire to the safe default, and adapters from the 9 current sources
- `crm.ts`: stage derivation
- `analytics.ts`: Home figures with their real / estimated / synthetic labels
- `digest.ts`
- `mailbox.ts`: `MailboxPort` tools (list, read, draft); no send
- `keys.ts`: registry, injection at the tool boundary, failure → pause dependants

**Ports and config**
- `packages/ports/src/mailbox.ts`: `MailboxPort` plus `FakeMailbox`
- `packages/ports/src/keys.ts`: `KeyStore` port plus fake, and a Secrets Store adapter
- `packages/config/src/keys.json`: the catalogue of key names and what uses each

**Dashboard** (`apps/dashboard/src/`)
- New pages: `Home.tsx`, `Crm.tsx`, `Inbox.tsx`, `Vault.tsx`, `NeedsYou.tsx`, `Keys.tsx`, plus placeholder `Ideas.tsx` and `Board.tsx`
- Existing pages become sections of these, not rewrites.

**Brain and scripts**
- `brain/status-and-vision.md` (stub)
- `scripts/gen-brain.ts`: bundles `brain/` for the Worker, the same way playbooks are bundled now

**Gates**
- `scripts/gate-v3-phaseN.ts` and `apps/api/src/gates/v3-phaseN.ts`, each with a CI test.

---

## 5. Decisions for the plan: my recommendations

### D1. Mail provider: **build against `MailboxPort` with a fake (your default), and receive replies with Cloudflare Email Routing**

- **Receiving.** Cloudflare Email Routing can deliver mail for a dedicated address on the sending domain
  (for example `replies@mail.ejtech.co.uk`) straight into the Worker, which stores it in `mail_messages`.
  That's **no new vendor**, it's on Cloudflare's free plan, and its docs are reachable. It is never your
  personal inbox.
- **Sending.** Keep this behind the existing `EmailSender` port and choose the provider later. Cloudflare's
  own Email Sending is in public beta and its docs describe it as for **transactional** email. Cold
  outreach isn't transactional, so check their terms before using it for outreach. A dedicated sending
  provider is the safer default.
- In Milestone C, I build the port, the fake and the inbound route. The adapter is marked unverified
  until your domain is onboarded.

### D2. Value of your time: **`OWNER_HOURLY_GBP` in config (your default), placeholder £40, labelled an assumption**

It's used by Home's "cost to serve", unit economics (your minutes × rate) and, later, idea-card ranking.
The dashboard shows it as an assumption until you set it.

### D3. What "pass" on an idea does: **your default, plus two safety conditions**

Pass queues the idea. A test starts automatically **only if all of these hold**:
- its budget is ≤ `AUTO_START_TEST_GBP`;
- it fits inside this week's remaining explore share;
- it stays within the playbook's spend tier;
- the card has kill criteria and a sample size.

Otherwise it raises a budget decision. (This is Phase 6, but the decision types are built in Phase 2.)

### D4. How API keys are stored: **Cloudflare Secrets Store, written through a narrowly scoped token**

From current Cloudflare docs:
- A Worker's binding to a Secrets Store secret is **read-only** (`get()`), and a value can't be viewed
  again once saved.
- Writing needs an API token with the **"Secrets Store Edit"** permission only.
- The alternative, writing Worker secrets through the Workers API, needs a token with Workers script
  edit rights. **That token could also deploy code**, which is far broader.

| | Secrets Store + scoped token | Encrypt with a Worker-secret key, store ciphertext |
|---|---|---|
| Value ever in D1 | **No** | Ciphertext would be in D1 (your requirement says values never reach D1) |
| What the Worker holds to write | a token that can only edit secrets | the master key; if D1 and the key both leak, everything leaks |
| Read path | binding `get()` at the tool boundary | decrypt at the tool boundary |
| Rotation / audit | Cloudflare dashboard, audit log | our own code |
| Catch | each key name needs a binding in `wrangler.jsonc` (a fixed catalogue in `keys.json`); Secrets Store was **beta** when announced, so confirm its status at cutover | more code of our own to get right |

**Recommendation: Secrets Store.**
- The dashboard's Keys page sends the value once to the Worker, which forwards it to Cloudflare's API
  with the scoped token and keeps nothing.
- The token itself (`CF_SECRETS_TOKEN`) is the one secret you set by hand with Wrangler.
- Locally there's a fake store, and tests prove no value reaches a model request, log line, D1 or
  `brain/`.
- Agents never call `get()`: keys are injected inside the tool registry when a tool runs.

### D5. Code changes without you writing prompts: **your default now (a "build request" card with a ready-to-run prompt); the GitHub upgrade only in Milestone D, with guard rails**

Current docs (code.claude.com, GitHub Actions page) say the Claude Code GitHub Action can run with a
prompt on any GitHub event, **including a schedule**. It has only the tools you grant it. It refuses
runs triggered by a bot unless that bot is explicitly allowed.

The shared Claude GitHub App holds broad permissions, **including Workflows (read and write)**, which
means it could edit CI files.

**Is the upgrade safe? Yes, but only with all of these:**
1. Trigger it from **your** action: a label you apply to the build-request issue, or an `@claude`
   comment. The engine can open the issue, but its bot can't trigger the run. **No scheduled code
   changes.**
2. Give the workflow only `contents: write` and `pull-requests: write`, set `--max-turns`, a timeout,
   and a separate API key with its own spend limit.
3. Use **CODEOWNERS plus branch protection** so any change to the safety layer, `.github/` or CODEOWNERS
   needs your review, and add a **CI path-guard** that fails a bot PR touching those paths.
4. **Never auto-merge code PRs.** Phase 10's auto-merge covers `brain/**` only, and later the narrow
   `playbooks/**` case you described.

The branch-protection and CODEOWNERS steps are GitHub settings I can't apply myself; they go on the
Milestone D list for you.

### D6 (mine). Mailbox MCP server: **build the three mailbox tools in the tool registry now; ship the MCP transport as an unverified adapter**

The MCP specification site is **blocked** from this environment, and our own playbooks call the Claude
API through the tool registry, not over MCP. So:
- The same three tools go into the registry: list, read and create draft. **There is no send, delete or
  forward tool**, and a test proves it.
- The MCP endpoint (`/mcp/mailbox`, behind Access with a service token) wraps those same tools. It's
  marked unverified until someone can check the spec.
- No new framework: Cloudflare's Agents SDK has MCP helpers, but it would be a new dependency.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| **Holdout leaks through the new CRM or Inbox** | One shared "blind" serializer for every company and task view; a test scans every new API response for arm or cohort fields. |
| **A second approval path survives the merge into one queue** | Old endpoints (`/api/tasks/:id/decision`, `/api/opportunities/:id/decision`, letters batch, claims publish, owner-approvals, effects resolve, dead letters) become thin wrappers that create and decide a `decision`. A static test checks that only `decisions.ts` writes `owner_approvals`, and a gate checks no approval exists without a decision. |
| **Safe defaults change behaviour** | The safe default is always "spends nothing, sends nothing": for a draft, don't send; for a print batch, don't print; for publish, don't publish. A defaulted holdout draft counts in lift like a rejected one (intent to treat, as now). Deadlines are in config (`decisions.json`) so you can lengthen them. |
| **Vault on Workers can't write to git** | Read `brain/` from a build-time bundle. Your edits and agent writes are stored as versions in D1, and Milestone D's brain-PR job turns them into pull requests. Until then, the Vault shows "edited here, not yet in git". |
| **Secrets Store status or limits** | Behind a `KeyStore` port with a fake; the adapter is checked against docs before deploy; Worker secrets remain a fallback for the cutover. |
| **Home figures disagree with each other** | Every tile computes from one ledger query module; the gate reconciles tiles to raw ledger rows on a fixture. |
| **Scope creep in Milestone C** | Ideas and Board are placeholders only; no agents are built until Milestone D. |
| **The phone-layout test gets slow with 7 pages × 2 widths × 2 datasets** | Already about 30 s; accept it and run the browser once per test file. |

---

## 7. Effort estimate (build sessions like the v2 ones)

| Phase | Kind | Estimate |
|---|---|---|
| C1 Shell, Home, CRM | mostly regrouping and new queries | 1.5 |
| C2 Needs-you queue and digest | new core (touches 9 approval sources) | 1.5 |
| C3 Inbox, MailboxPort, mailbox tools/MCP | extension plus a new port | 1 |
| C4 Vault | new, but simple | 1 |
| C5 Keys | new, security-sensitive | 1 |
| **Milestone C** | | **about 6** |
| D6 Ideas, Board, research agents | largest new build | 2.5 |
| D7 Standing rules, sampling, golden cases | | 1.5 |
| D8 Coordinator, operations agent, breakers | | 1.5 |
| D9 Hands-off delivery | | 1.5 |
| D10 Money, auto-merge, x402 deploys, the loop | | 2.5 |
| **Milestone D** | | **about 9.5** |

---

## 8. What I'll change in `CLAUDE.md` after approval

- The v3 milestones: C to be built, then stop; D frozen until you approve after C.
- New rules:
  - one decisions queue, and no page may hold its own approval list;
  - a safe default is never recorded as your approval;
  - keys are write-only and injected at the tool boundary;
  - agent writes to the Vault are new versions.
- The commands for the v3 gates.

## Decisions I need from you

1. Approve the plan as written, or change any of D1–D6.
2. Confirm the page mapping, especially Golden set → CRM "Verify" tab, and Metrics' quality sections →
   Home.
3. Optional: your hourly rate for `OWNER_HOURLY_GBP`. Otherwise it's £40, labelled an assumption.
