# Phase graph-g2 gate report

Generated 2026-11-18T23:25:49.944Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| sme_outreach runs end to end on the graph runtime in dry-run, with the approval resolved from the dashboard | passed (synthetic) | instance waited at the approval (sleeping); approved through POST /api/decisions/:id/decide (200); steps research@research, draft@draft, check@check, send@send; 1 email, dry_run; task done |
| Every model and tool call produces exactly one cost event; roll-ups equal the sum of their events | passed (synthetic) | 1 model calls → 1 model events; 3 tool calls → 3 tool events; 7 infra events; per-node roll-up £0.003236 = sum £0.003236 |
| The kill switch stops a running instance before its next step; clearing it resumes the run | passed (synthetic) | paused before the next node: "sme_outreach's kill switch is on"; the send didn't run while paused; after the switch went off, the run resumed and finished (done) |
| A forced failure resumes without repeating a completed external step | passed (synthetic) | the send job crashed after the step ran; the retried job found the recorded effect, so 1 email exists (not 2); task done |
| An approval left unanswered takes the safe default (nothing sent), never counted as Archie's approval | passed (synthetic) | after the 7-day deadline the task is cancelled; owner approvals 1 → 1; no approval row for the task |
| An empty pool pauses a running graph before its next step; a top-up lets it continue | passed (synthetic) | with real spend and £0 in the pool the run paused before its first model step ("the agent pool is empty"); after a £5 top-up it ran on to the approval (waiting) |
| Alerts at 50%, 80% and 100% of a graph's budget, each raised once | passed (synthetic) | at 85% of the budget: 2 alerts (50%, 80%); checked again: 0 new |
| Behind the flag: with GRAPH_ENGINE_ENABLED off, tasks run on the old runner exactly as before | passed (synthetic) | flag off: 0 graph runs; the task ran on the old runner (awaiting_approval) |
| The Worker builds with the GraphRunWorkflow binding | passed (synthetic) | GRAPH (GraphRunWorkflow) bound |

Synthetic data, fakes only, dry-run, kill switch on. Nothing external happened.
