---
type: build-report
phase: v3-2
date: 2026-11-17
status: gate passed (synthetic)
---

# v3 Phase 2: Needs-you queue and digest (gate report)

## What changed

**One queue for everything that needs you** (rule 18). It's at the top of Home, ranked by money at stake.
Each item is a `decision`, with:
- a summary;
- the money at stake, labelled real or estimated;
- the options, with what each one does;
- the recommended option, highlighted;
- the **safe default**;
- a deadline.

The queue fills itself from 8 sources:

| Type | From | Safe default |
|---|---|---|
| lead | proposed leads (top 50, skipping companies in the contact cooldown) | skip |
| draft | email and reply drafts waiting for review | don't send (task cancelled) |
| print_batch | pending print batches | don't print |
| claim_publish | claimed sites ready to publish | don't publish |
| uncertain_effect | external actions with an unknown outcome | leave blocked (never repeated) |
| dead_letter | failed jobs | set aside |
| data_conflict | fact conflicts (choose a value or leave) | leave |
| quarantine | unmatched records | leave |

Raising a spend tier and changing autonomy are decisions too. They're created and decided in one tap when
you ask for them.

**One tap, one path.** Every choice goes through `decide()`
(`packages/infra/src/decisions.ts`). It writes exactly one recorded approval, the same mechanism spend
tiers and L3 already used, and then applies the option. The old approve buttons still work, but each one
now decides the matching queue item:
- task draft, lead, print batch and claim publish;
- uncertain action, dead letter and quarantine;
- tier raise and promote.

The separate approval lists are gone:
- **Review is removed.** Inbox → Drafts shows the queue filtered to drafts.
- **Claimed sites and Runtime health** now link to the queue.
- **Letters** keeps the batch details (PDF and flags) behind the batch's queue item.

**Safe defaults** (rule 19). When a deadline passes, the item takes the option that spends nothing and sends
nothing. It's recorded as "defaulted", with no owner approval and no approval-history row, so it can never
look like your decision. Home has a "Recently defaulted" list. Deadlines are in config
(`packages/config/src/decisions.json`): leads 7 days, drafts 3, print batches 7, publish 5, data items 30.

**Daily digest.** A short summary of yesterday is shown on Home: events, money earned and spent, decided,
defaulted and waiting. The cron builds it once a day after 06:00 UTC. Email delivery comes with the mailbox
port and a real sender.

**The cron** now syncs the queue and applies expired defaults every 5 minutes (job `decisions`).

## Gate (`pnpm gate:v3 --phase 2`, docs/gates/v3-phase2.md)

| Criterion | Status |
|---|---|
| Decisions from many sources appear in one list, ranked by money at stake (6 sources in the fixture) | passed (synthetic) |
| An expired decision takes its safe default and is never counted as an approval | passed (synthetic) |
| No approval can be created except through the decisions path (behavioural and static) | passed (synthetic) |
| The queue keeps the holdout hidden | passed (synthetic) |
| Daily digest: what happened, earned, spent and waiting | passed (synthetic) |

`pnpm check` is green: 377 tests in 48 files. Migration 0014 adds `decisions` and `digests`. It also
rebuilds `owner_approvals` to add `kind = 'decision'` and a `decision_id`, keeping the v2 rows.

## Notes

- **Expiry deliberately ends things.** For example, a draft that waits past 3 days is cancelled. If you'd
  rather leave things waiting longer, raise the hours in `decisions.json`; no code change is needed.
- **Fix-or-kill cards don't exist yet.** They were planned for v2 Phase 6 (frozen) and come in Milestone D.
  The decision type is reserved for them.
- **The playbook golden set** (Milestone D, captured from your decisions) will hang off this queue, as you
  asked.

Next: Phase 3, the Inbox and mailbox port.
