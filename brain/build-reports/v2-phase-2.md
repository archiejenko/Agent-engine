---
type: build-report
phase: v2-2
date: 2026-11-16
status: gate passed (synthetic + Worker build)
---

# v2 Phase 2: Workers runtime (gate report)

## In one paragraph

Production now has everything it needs to run on Cloudflare Workers (decision D3).
- **Schedule and queue.** A scheduled trigger fires every 5 minutes and puts jobs on a queue. A consumer
  runs them. A job that keeps failing is retried 3 times, then set aside on a dead-letter queue, which
  raises an alert.
- **Workflows.** Multi-step work that spans days runs as Cloudflare Workflows. A live workflow stops
  within one step when you turn the kill switch on, and carries on from the same place when you turn it
  off.
- **No repeated external actions.** Every external action is written down before it happens. A retry
  after a crash gets the first result back instead of acting twice. If nobody can tell whether an action
  happened, it's never retried automatically: it waits on the health page for you to say.
- **Change feed and triggers.** A Durable Object is ready to follow the Companies House change feed, with
  polling as the fallback. Change events pass through cheap rules first, so the model is only called for
  the few that matter.
- **Locally**, the same jobs run in Node against SQLite.

## What was built

| Part | Where | Notes |
|---|---|---|
| Cron → queue → consumer | `wrangler.jsonc`, `apps/api/src/runtime-worker.ts` | every 5 min: agent loop, polling fallback, workflow wake-ups |
| Dead-letter queue | `ae-jobs-dlq` | 3 retries (60 s apart), then recorded in `dead_letters` + alert |
| Job handler | `apps/agent-runner/src/jobs.ts` | one `handleJob` for Worker and Node; `LocalJobQueue` copies the retry/DLQ rules |
| Workflow engine | `packages/infra/src/workflow.ts` | one step contract; Cloudflare adapter `EngineWorkflow`; local runner persists steps in `workflow_steps` |
| No repeated external actions (rule 17) | `packages/infra/src/tools.ts`, table `external_effects` | recorded before the call; done → result replayed; unknown → refused until a person settles it |
| Change feed | `ChangeFeed` Durable Object + `change-feed.ts` | holds the feed position; delivers before moving it; reads the existing stream client when `CH_STREAM_KEY` is set (to verify at cutover) |
| Polling fallback | `pollFallback` | takes over when the feed is missing or quiet for 30 min; refreshes leads and watched companies in rotation and turns changes into the same events |
| Trigger rules | `packages/config/src/triggers.json`, `triggers.ts` | 5 rules; only `explain` calls the model; counts per rule per day in `trigger_stats` |
| Health page | `/api/runtime`, Controls → Runtime health | heartbeats, feed state, failed jobs, uncertain actions (with "It happened" / "It didn't happen"), paused or errored workflows, trigger counts |
| Real model switch | Worker var `MODEL_LIVE` | the Worker uses the fake model unless `MODEL_LIVE=1` **and** the `ANTHROPIC_API_KEY` secret are set. Models are unchanged. |

**Workflows registered so far: none.** The engine is ready. Phase 4 adds claim-this-site fulfilment, and
the weekly and monthly loops are Milestone B. The gate exercises the engine with a fixture workflow.

## Gate (docs/gates/v2-phase2.md): `pnpm gate:v2-phase2`

| Criterion | Status |
|---|---|
| Global kill switch stops a live workflow within one step; resume continues where it stopped | passed (synthetic) |
| Kill/resume and a crash after an external action cause no repeated action | passed (synthetic) |
| An action whose outcome is unknown is never repeated automatically; a person settles it | passed (synthetic) |
| 1,000 change events: the model is called only for rule matches (110 matched → 3 model calls, all leads) | passed (synthetic) |
| Queue: a failing job is retried, then dead-lettered with an alert; other jobs run | passed (synthetic) |
| Change feed not connected → polling fallback feeds the same trigger rules | passed (synthetic) |
| Health page shows heartbeats, dead letters, uncertain actions, workflows, trigger counts | passed (synthetic) |
| The Worker builds with its Cron, Queue + DLQ, Durable Object and Workflow (`wrangler deploy --dry-run`) | passed |

**Tests:** `pnpm check` is green: 364 tests in 43 files, and the Worker's own typecheck. New tests:
`packages/infra/src/__tests__/v2-runtime.test.ts` and `apps/api/src/gates/v2-phase2.test.ts`.

**A bug the gate caught:** the trigger processor silently ignored events past 500 in one batch. It now
processes everything it's given, and the batch size is applied when events are put on the queue (split
into several messages).

## What's NOT done, and why

1. **The Companies House stream isn't verified yet.** *(Corrected after Phase 4.)* An earlier phase had
   already built a stream client, `HttpChangeStream`, with its host, paths, auth and event shape flagged
   "to verify at cutover". The change feed now uses it, through `streamFeedSource`, whenever the
   `CH_STREAM_KEY` Worker secret is set. Without the key, the health page says "change feed: not
   connected" and polling does the work.

   I couldn't re-check the streaming docs here: the docs host and the stream host are both blocked by
   this build environment's network policy. Verifying them stays on the cutover checklist. The stream
   needs its own **stream key** from Companies House, which is different from the REST API key.
2. **Cloudflare delivery itself hasn't run for real.** Queue retries, Workflow scheduling and Durable
   Object alarms are configuration plus thin adapters. They're checked by the Worker build, and get their
   first real run when you deploy (in the cutover checklist). The logic they call is tested locally.
3. **Polling covers leads and watched companies, not the whole universe**: 50 per 5-minute run, in
   rotation, about 14,000 a day. That's within the Companies House API's limit. The change feed is what
   covers everything.

## New config values that need your eye

| Config | Now | Meaning |
|---|---|---|
| `triggers.json` → `fallback_poll.feed_stale_minutes` | 30 | how long without feed events before polling takes over |
| `triggers.json` → `fallback_poll.entities_per_poll` | 50 | companies refreshed per 5-minute run while polling |
| `triggers.json` → `rules` | 5 rules | which changes act; only "a lead filed accounts → re-explain the lead" calls the model |
| `wrangler.jsonc` → cron | every 5 min | how often the loop runs |

Next: Phase 3 (hard budgets in a Durable Object, S-tiers, explore share).
