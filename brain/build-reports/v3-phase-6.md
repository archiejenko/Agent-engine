---
type: build-report
gate: v3-phase-6
date: 2026-11-19
status: gate passed (9 of 9, synthetic, fake model, dry-run)
---

# v3 Phase 6: Ideas feed, Board and the research agents (gate report)

Evidence: `docs/gates/v3-phase6.md` (`pnpm gate:v3 --phase 6`). This includes v2 Phase 7 (scouts, planner,
opportunity cards, hypothesis backlog, volume check, injection suite), as your v3 brief asked.

## What you can do now (dashboard)

- **Ideas.**
  - A feed of idea cards, ranked by expected profit per hour of your time, with function and market
    filters.
  - Each card shows:
    - the market, offer and function;
    - the evidence (signals and verified facts);
    - the economics: cost to serve, cost to acquire, first-year value, payback, market size, the test
      budget, the sample size and time cap, and the kill criteria.

    Every number is labelled real, estimated or assumed, and anything not real shows its assumption.
  - Buttons: **Pass**, **Fail** (your reason is required) and **Park**. They resolve through the one
    decisions path, the same as Needs you.
  - **Ask a question:** the planner answers with evidence from the card. If the answer changes an
    assumption, the card gets a new version.
  - **Comment**, and on a regulated introduction card, **Record legal check**.
  - Cards rejected before they reach you (under-powered, or a failed idea raised again unchanged) are
    listed under "held back", with the reason.
- **Board.** Markets as tiles in six columns: scanning, researching, proposed, testing, live, killed.
  - Each tile shows its signals, its cards, and money spent and earned, with synthetic money shown
    separately.
  - Agents move tiles. You can **pin** or **kill** one; each tap is recorded as your decision.
  - Columns stack on a phone.

## How it works

- **Scouts read; they never act.** A scout is plain code with no tools. It turns structured records from
  a field's listed sources into **signals**, which have a strict, short shape:
  - a value is a number, a yes/no, or a short code;
  - the buyer comes from a closed list in config;
  - the industry must be a known sector.

  Raw page text never leaves the scout, and a source whose terms forbid reuse lands in the licensed lane.
- **The planner builds cards in code** (rule 4).
  - The conversion estimate is the ledger's (the prior until real sends exist), and the send cost comes
    from config.
  - Your time is priced at `OWNER_HOURLY_GBP`, and market size is a real count of companies.
  - A figure built from others takes the weakest label among them.
- **Checks before a card reaches you:**
  1. **Volume check.** If this week's send volume can't reach the sample size inside the time cap, the
     card is rejected.
  2. **Re-raise.** A failed or killed idea comes back only if it says what changed *and* differs from
     the failed version.
  3. **Regulated introductions.** Pass isn't offered until you record the legal check.
- **Pass (your decision D3).** The test starts by itself only if all of these hold:
  - its budget is at or under `auto_start_test_gbp`;
  - it fits this week's explore share;
  - it fits the playbook's spend tier;
  - there's a free send-volume slot;
  - it has kill criteria and a sample size.

  Otherwise you get a **test budget** decision.
- **Experiments.** A daily workflow checks the kill criteria against the experiment's own ledger rows.
  - When one trips, the experiment **kills itself**, moves its tile to killed, and writes a post-mortem
    to the Vault at `brain/experiments/<id>.md`. It's an agent note with provenance, labelled synthetic
    here.
  - On success, its tile goes to live and you get a decision for the next budget step.
- **Your fail reason** goes to the decision log, which the planner reads, and to the seeded hypothesis if
  there is one. It **never goes to the outcome ledger.**
- **On Cloudflare,** a question is answered in the queue consumer (an `idea_question` job). Locally it's
  answered straight away.

## Gate criteria (all passed, synthetic)

1. A scripted signal becomes a card with **all 19 figures** filled and labelled.
2. A question gets an answer citing the card's evidence, plus a **new version** (first-year value £900,
   labelled estimated, with the reason).
3. Pass starts the test by itself, and 100 simulated sends with 1 demo visit follow. On day 10, "demo
   visits per 100 sends 1.00 < 3" trips, and the experiment kills itself and writes its post-mortem.
4. The Board recorded every stage: scanning → researching → proposed → testing → killed.
5. A failed idea raised again unchanged is blocked. Saying "what changed" without changing the card is
   also blocked. A genuinely changed card goes through.
6. An under-powered card (5,000 sends in 21 days at 100 a week) is rejected and opens no decision.
7. A regulated introduction card can't be passed until the legal check is recorded.
8. **Injection suite.** 6 poisoned records carried instructions, a fake tool call, hidden text,
   `<script>` and a "SYSTEM:" buyer:
   - 5 were rejected;
   - the clean one was kept, with its hidden page text dropped;
   - 0 planner requests and 0 cards carried injected text;
   - scouts and the planner made 0 tool calls.
9. The feed is ranked by profit per hour. Pass and fail wrote exactly 2 owner approvals; questions,
   comments and the legal check wrote none.

The phone and desktop layout test now seeds idea cards and Board tiles, and covers a card page.

## Numbers you need to set (all labelled "assumed" until you do)

All in `packages/config/src/ideas.json`, apart from your hourly rate and the conversion priors, which
live in `infra.json`:

| Setting | Placeholder |
|---|---|
| `auto_start_test_gbp` | £5 |
| Cost to serve one customer | model £0.50, hosting £60 a year, third-party £20 a year, 30 of your minutes |
| Test defaults | 200 sends, 21 days, £4 budget, £25 next step |
| `weekly_send_capacity_assumed` (used until real sends exist) | 100 |
| Default kill criteria | under 3 demo visits per 100 sends by day 10; spend of £4 |
| Review minutes per send (in code, labelled assumed) | 1 |

There are also the buyer list and the scouting fields: SME websites, and business lending introductions
(flagged regulated).

## Limits

- **The planner's answers come from the fake model here.** With `MODEL_LIVE = "1"` and your key, the
  `planner` role (Opus 5.5, high effort) answers, and the same evidence check refuses any answer that
  doesn't cite the card.
- **No scout runs on a live source yet.** The scout function and its rules are built and tested. The job
  that feeds it from the Companies House change feed every day comes with the coordinator (Phase 8).
- **Experiments don't create outreach tasks by themselves yet.** In the gate, sends are simulated straight
  into the ledger. Linking an experiment's sends to real `sme_outreach` tasks waits for your go-ahead on
  live sends, and stays dry-run until then.
- Plan status on each card reads "not planned yet" until the G4 planner builds graphs for cards.
