---
type: build-report
milestone: cockpit-U3
date: 2026-11-27
status: STOPPED — waiting for Archie (not merged)
---

# Cockpit UI U3: the other pages — stop-point report

The rest of the dashboard now uses the cockpit kit. Your U2 answers are built, and every approve button
in the dashboard goes through `/api/decisions/:id/decide`. Gate evidence and the ready-to-merge checklist
are in `docs/gates/cockpit-u3.md`. **I've stopped here and haven't merged.**

## 1. What changed, page by page

| Page | What's new |
|---|---|
| **Home** | Needs you is one compact row per decision (type, title, money at stake, due date and buttons); "Details" opens the reason and what each option does. The leaderboard lists only playbooks with live money in the period, with "Show all (N)", and is one card per playbook on a phone. Runway links to the top-up form |
| **Ideas** | A board: new → approved → executing → earning → killed. Each card shows cost to serve, cost to acquire, expected revenue, confidence and plan status; Pass, Fail (asks for your reason) and Park go through `/decide`. The function and market filters and the "held back" list stay |
| **Board** | A heatmap at the top: industry × what we'd sell. Colour = the market's best idea (expected profit per hour of your time, estimated); number = agent spend there. The tiles, Pin and Kill stay where they were |
| **CRM** | Companies opens on a pipeline board: one column per stage, with count and value. A switch goes back to the table; Export CSV stays. The holdout stays blind |
| **Inbox** | A strip at the top: sent, replies and positive replies per playbook (or test), with both rates worked out by the API |
| **Controls** | A gauge per playbook (today's spend against its cap) and autonomy as L0–L3 steps; the Agent pool (runway); and a **Record a top-up** form. Kill switches and the table are unchanged |
| **Vault** | "Learned this week" at the top: agent notes from the last 7 days, with who wrote them, how many sources and ledger rows, and any labels |

Every new figure comes from the panel registry, through the same guard: holdout blind, simulated rows
only on request, no secrets, money in pennies. Each page has its own layout file, checked when the
dashboard builds.

## 2. Your U2 answers, as built

1. **Simulated leads, option (b).** The test world (gates, screenshots, the phone test) marks its own
   leads as simulated. That uses a tiny new storage method, and a test lets only the test world call it.
   - **Production safety test.** A new test proves the simulator and rehearsal loaders can't write to
     `agent-engine`, `agent-engine-facts` or `agent-engine-telemetry`:
     - nothing that generates or loads simulated data is in the deployed Worker;
     - the loaders only ever open local SQLite files.
   - **No such path existed today,** so there was nothing to stop for.
   - **Worth knowing:** until cutover (`MODEL_LIVE` off), the deployed Worker uses a stand-in "fake
     model". Its website extractor only quotes what's on a real page and invents nothing. It's now in
     its own file, apart from the fake-website generator, which the test proves never ships.
2. **Leaderboard:** active playbooks only, plus "Show all (N)", and phone cards.
   - Simulated spend today doesn't make a playbook "active". Caps count it, as they always have.
3. **Runway and the low-runway rule.**
   - **There was no top-up form in Controls.** The "record a top-up in Controls" hint I added in U1
     pointed at nothing; sorry. I built the form. It records the top-up as your approval through
     `/decide`, because a top-up raises what agents may spend.
   - **Low-runway rule.** When runway drops below `low_runway_days` (default 14, in `decisions.json`),
     one "Top up or pause" decision opens.
   - **Safe default:** pause the task queue (spends nothing).
   - **Never repeated** until another top-up or adjustment is recorded.
   - The runway maths now lives in one place (`packages/infra/src/runway.ts`) for the panel and the rule.
4. **The four older buttons** (raise a tier, promote, Board pin/kill, print batch) now resolve through
   `/decide`.
   - For things you start yourself, the dashboard first opens a decision with
     `POST /api/decisions/request`, which approves nothing.
   - The static test has no allow-list.

## 3. Tests and size

- `pnpm check` green: **628 tests in 93 files** (38 more than U2).
- New:
  - simulator isolation (9);
  - low runway and top-up (7);
  - request route (3);
  - page queries (7);
  - leaderboard filter;
  - compact row (2);
  - a forced-failure test on each page that uses panels;
  - leaderboard phone cards and the Runway link in the browser.
- Bundle (gzipped): main 93.08 KB (U2: 92.30); kit and charts 117.29 KB, loaded only on pages with
  panels.

## 4. Deviations, and why

- **Ask (Ideas) isn't a `/decide` button.** Deciding closes the card's decision. Ask stays the question
  box on the card's page, which records nothing as an approval.
- **The Ideas board is empty in the test world.** Its three seeded cards are all held back as
  underpowered, so they never reach you. Its tests use cards in every column.
- **The Board heatmap is empty with "Include simulated" off,** because every test-world market is
  simulated.
- **The CRM board still lists "SYNTHETIC TRADING" companies,** exactly as the CRM table already did.
  Option (b) marks decisions only; those companies carry no simulated flag anywhere.
- **The top-up form is new,** as explained in section 2 point 3.
- **One small shared fix:** `reviewTimer.ts` can now be imported outside a browser, so component tests
  can render decision cards. No change in the browser.

## 5. For you to decide or check

1. **Ready to merge?** The checklist is in `docs/gates/cockpit-u3.md`. Merging into
   `claude/nifty-curie-91l1nq` is your call; the GitHub Deploy workflow then deploys.
2. **Low-runway threshold:** 14 days by default. Change `low_runway_days` in `decisions.json` if you
   want another number.
3. **Board score:** the colour uses "best idea's expected profit per hour of your time". If you'd rather
   it used something else (for example signal count or company opportunity score), say which.
4. **Pre-cutover fake model:** see section 2 point 1. Nothing to do, but worth knowing before you switch
   `MODEL_LIVE` on.
