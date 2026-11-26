# Phase v2-2 gate report

Generated 2026-11-26T20:25:57.291Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Global kill switch stops a live workflow within one step; resume continues where it stopped | passed (synthetic) | switch turned on during step 1 → stopped before step 2 (steps run: prepare; status paused); resumed → complete; "prepare" ran 1 time(s) |
| Kill/resume and a crash after an external action cause no repeated action | passed (synthetic) | the step crashed after its action and was retried: the action was recorded once (gate_notify: done), the outside world was touched once; the retry got the recorded result back |
| An action whose outcome is unknown is never repeated automatically; a person settles it | passed (synthetic) | first attempt failed mid-call ("connection reset after sending"); second attempt refused ("tool gate_notify blocked: an earlier attempt's outcome is unknown (unknown); not repeating…"); shown on the health page for a person to mark happened / didn't happen |
| 1,000 change events: the model is called only for rule matches | passed (synthetic) | 1,000 events (1000 processed) → 110 matched a rule (expected 110; trigger_stats model calls 3) → 3 model calls (expected 3, all for leads); 890 ignored by the cheap filter with no model call; per-rule counts in trigger_stats |
| Queue: a failing job is retried, then lands on the dead-letter queue with an alert; others run | passed (synthetic) | poison job tried 4 times (1 + 3 retries) → dead letter + alert; scheduled jobs ran: tick, poll_fallback, workflows_tick, decisions |
| Change feed not connected → polling fallback takes over and feeds the same trigger rules | passed (synthetic) | feed configured: false; polling refreshed 173 companies, found 1 change(s); 10000068 went into liquidation → status_changed rule → alert |
| Health page shows heartbeats, dead letters, uncertain actions, workflows and trigger counts | passed (synthetic) | heartbeats: decisions, events:poll, poll_fallback, tick; 1 dead letter; workflows {"complete":1} |
| The Worker builds with its Cron, Queue (+ dead-letter queue), Durable Object and Workflow | passed | wrangler deploy --dry-run: bindings CHANGE_FEED, ENGINE, JOBS, DB; cron and queue consumers in wrangler.jsonc |

Cloudflare delivery itself (Queues retries, Workflows scheduling, Durable Object alarms) is configuration; it gets its first real run when Archie deploys (cutover checklist).
The Companies House streaming adapter is not built: its documentation host was blocked from the build environment. Polling covers it until then.
