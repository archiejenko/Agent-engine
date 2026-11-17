# Phase v3-5 gate report

Generated 2026-11-17T21:01:35.667Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Keys are write-only: saved through the dashboard API, never returned; bad names and values refused | passed (synthetic) | 5 API responses (save, list, refusals) and none contains the value; EMAIL_API_KEY shows "set"; 6 keys listed with their dependants; the table has no value column (static test) |
| Keys are injected only at the tool-registry boundary, only on live calls, and scrubbed on the way out | passed (synthetic) | a live call to a tool that declares EMAIL_API_KEY received it; a tool that declares none got nothing; a dry run got nothing; a tool that echoed the key returned "{"echoed":"[key removed]","nested":["Bearer [key removed]"]}"; the call log holds no value. Only packages/infra/src/keys.ts reads keys (static test) |
| Leak test: no key value in a model request, a log line, the database or brain/ | passed (synthetic) | 1 model requests captured during a real playbook run, none with the value; 0 log lines, none with it; every database table scanned (0 hits); brain/ scanned (0 hits); the Claude client sends the key only in its auth header (body checked) |
| A refused key raises one decision and pauses only the playbooks that depend on it | passed (synthetic) | the provider's 401 marked EMAIL_API_KEY failing (error kept, value removed); paused: sme_outreach, post_reply, claim_site, human_report, monitoring_subscription, watch_alert (exactly the key's dependants); the next call was refused before acting; one decision (safe default: keep paused); an sme_outreach task stayed queued while an sme_letter task ran (awaiting_approval; awaiting_approval); the deadline defaulted without an approval; saving a new key resumed them |
| A missing key is refused before anything happens, and shows as not set | passed (synthetic) | "key CH_API_KEY isn't set (add it on Controls → Keys)"; no external action was recorded |

Synthetic data, fakes only, kill switch on. Nothing external happened.
