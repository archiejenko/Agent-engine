---
type: build-report
date: 2026-11-19
status: task graph layer G0–G5 and v3 Phase 6 built and gated, all in dry-run; waiting for Archie
---

# Task graph layer: summary (G0–G5, with v3 Phase 6)

Each gate has its own report in `brain/build-reports/` (graph-g0 … graph-g5, v3-phase-6) and evidence in
`docs/gates/`. Everything ran on synthetic data, with fakes and the kill switch on. **Nothing external
happened.**

## What's built

| Gate | What | Result |
|---|---|---|
| G0 | Contracts, storage (migrations up and down), node library export, price table checked against Anthropic's live page on 2026-11-18 | passed |
| G1 | Compiler (16 rules), one interpreter, 7 playbooks as graphs (6 proven equivalent to the old runner; `claim_site` waits on your decision) | passed |
| G2 | `GraphRunWorkflow` on Cloudflare Workflows behind `GRAPH_ENGINE_ENABLED`; kill switch, crash-resume, pool, budget alerts, cost ledger | 11 of 11 |
| G3 | Sandbox: live ports refused, external tools dry, no network; reports per playbook and scenario; probes; a failing node is a recorded failure | 7 of 7 |
| Phase 6 | Ideas feed, Board, scouts, idea cards with labelled economics, questions, experiments that kill themselves, injection suite | 9 of 9 |
| G4 | The planner: probes, 3 attempts, sandbox, approval card; eval 18/20; canaries never reach it | 8 of 8 |
| G5 | Shapes, settling, promotion at L1, breaches drop a level; synthetic and dry-run never count | 6 of 6 |

`pnpm check` is green: 487 tests.

## Decisions waiting for you

1. **`claim_site` as a graph** (from G1). Option c now (it stays on its workflow), option a later. See
   `graph-g1.md`.
2. **The old-runner bug in `human_report`** (from G1): a frozen path; I reported it and didn't change it.
3. **Removing the old runner loop** (from G2). I'd do it once the flag has been on in production for real
   `sme_outreach` runs.
4. **A sandbox D1 database** (from G4), so the planner can plan on Workers. Today it plans in the Node
   tick.
5. **The Costs page and live run view** (from G4). The data exists; next up unless you'd rather wait.
6. **Numbers to set** (Phase 6). The card cost model, auto-start limit, test defaults and kill criteria
   are all placeholders, labelled assumed.

## What needs your key (Stage 5 is on your deployment)

With `MODEL_LIVE = "1"` and the Anthropic key, these run for real:
- the sandbox's per-node costs (G3);
- the planner's eval and planning costs (G4). Run `pnpm gate:graph --gate 4` there; it records the real
  result against prompt v1;
- the planner's answers to your questions on idea cards (Phase 6).

## To try it (dry-run)

Set `GRAPH_ENGINE_ENABLED` to `"1"`, locally (`GRAPH_ENGINE_ENABLED=1 pnpm --filter @ae/agent-runner tick`)
or as the Worker var. Then:
1. Pass an idea on Ideas.
2. Wait for the planner to propose a plan (Needs you → Plan).
3. Approve the plan.
4. Its run will ask you to approve the draft, as today.

Set the flag back to `""` and everything returns to the old runner.
