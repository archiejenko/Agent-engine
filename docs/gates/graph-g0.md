# Phase graph-g0 gate report

Generated 2026-11-18T22:29:09.341Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Graph schemas: a valid spec passes; specs that set a lane, smuggle code, request permissions or misname nodes fail | passed (synthetic) | example spec accepted; rejected: planner-set lane ✓, code smuggled in ✓, unknown entry ✓, role that doesn't exist ✓, permission request on a node ✓, dot in a node id ✓; 13 contract tests in packages/contracts |
| Migrations 0020–0022 run up, down and up again; down files sit outside the folder wrangler deploys | passed (synthetic) | 0020_graph_core.sql, 0021_cost_ledgers.sql, 0022_graph_shapes.sql: up → 75 tables, down → 64, up again → 75; schema compared column by column in packages/storage tests |
| The node library export lists every registered tool, role and function, deterministically | passed (synthetic) | 12 tools (5 act externally), 4 roles, 8 functions, 7 playbooks; registry version 3fb89af23b1786f3 (same with tools in reverse order) |
| Model price table checked against Anthropic's live pricing page (2026-11-18); a call priced from reported usage matches a hand calculation | passed (synthetic) | checked https://platform.claude.com/docs/en/about-claude/pricing on 2026-11-18 (the page shows no "last updated" date): claude-opus-5-5 matches; claude-sonnet-5-5 matches; claude-haiku-5-5 matches; cache-read and cache-write prices and Haiku's >100k tier added; price table version 2026-11-18 |
| Archie's reasons live in a separate decision log, never in the outcome ledger; money ledgers are append-only | passed (synthetic) | a reason canary appears only in: decision_log; deleting a cost event: "cost_events is append-only" |
| No runtime change: nothing calls the graph layer yet; every existing test and gate stays green | passed (synthetic) | the graph package has no callers in the runner, API routes or Worker; `pnpm check` (every v1–v3 gate test included) is green at this commit |

Synthetic data, fakes only, dry-run, kill switch on. Nothing external happened.
