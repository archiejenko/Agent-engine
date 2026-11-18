---
type: build-report
gate: graph-G3
date: 2026-11-18
status: gate passed (7 of 7, synthetic, fake model); real-model costs wait for your deployment
---

# Task graph G3: the sandbox (gate report)

Evidence: `docs/gates/graph-g3.md` (`pnpm gate:graph --gate 3`).

> Sandbox proves mechanics and cost, not demand.

## What was built

- **A sandbox mode for the agent service** (`sandbox: true`). It changes four things:
  - Every port must be a fake. If it's handed a live key ring, email sender, inbox, alert channel, web
    fetcher, workflow port, queue or budget port, it refuses to start. The model is the one exception:
    a real model gives real costs.
  - The tool registry runs **every external tool dry**, whatever the kill switches say, and never injects
    a key.
  - Every task it creates is **synthetic**, so it's never learned from (rule 10).
  - Its spend is recorded as **sandbox spend** (`mode: "sandbox"`). It never counts as live: not on the
    Costs page, not against the daily cap, and not in budget alerts.
  - A run also stops before any node that would push it past the **£2 per-attempt sandbox cap**.
- **The sandbox runner** (`apps/agent-runner/src/sandbox.ts`). It runs one playbook's graph through one
  scenario, on the real graph runtime, in a fresh synthetic world. It then writes a `sandbox_reports` row
  with:
  - each node's status and cost;
  - the sandbox cost and the projected live cost;
  - any failures;
  - the note above.
- **Scenarios per playbook.** Each playbook gets the happy path plus every failure that applies to it:
  - **Archie rejects:** where the playbook asks for an approval.
  - **Tool error:** on the first tool its happy path actually called.
  - **Kill switch on:** for every playbook; the run must pause before its first node.
- **Probes** (`packages/graph/src/probe.ts`). A probe is a small, read-only graph the planner may ask for
  in G4. It may have at most 5 nodes, and no operator, approval, wait, or anything that can act
  externally. A role is refused if its step merely lists an external tool. Probe spend and sandbox spend
  share the **£5 per-graph cap**.

## Gate criteria (all passed, synthetic)

1. **Isolation.**
   - All 8 live ports are refused.
   - With every kill switch off, all 5 external tools ran dry and none got a key. Outside the sandbox the
     same 5 calls ran live, which shows the check can fail.
   - The whole gate made **0 network calls**: `fetch` was replaced with one that counts and refuses.
2. **Reports for all six converted playbooks**: happy path plus failure scenarios (19 runs), each with
   per-node cost.
3. **No sandbox spend appears as live.** All 56 cost events have mode "sandbox", there are 0 live events,
   every task is synthetic, and no daily-cap alert was raised.
4. The **per-attempt sandbox cap** pauses a run before the node that would cross it.
5. **Probes** are accepted or refused correctly, and they share the per-graph cap.
6. **A failed node is a recorded failure.** The task ends `failed` with the reason (for example
   "research: sandbox: verified_facts is down"), and you get an alert.
7. Every report carries the note and says which model it used.

## Found and fixed along the way

- **A failing role node used to leave a graph run stuck at "running" forever.** A tool down or a model
  error made the job throw, so nothing told the workflow, and on Cloudflare it would have errored with no
  record. Now:
  - the node records the failure and its cost so far;
  - the workflow ends the run and the task as `failed`, with the reason;
  - you get a `graph_failed` alert.

  A node that never reports back (for example, dead-lettered) takes the same path.
- **Sandbox tasks weren't marked synthetic.** They are now.
- The G0 "no runtime change by default" check now also allows the sandbox file to import the graph layer.
  It runs only when a gate or the planner calls it.

## Limits of this gate

- **The model is fake.** By rule 20, the Anthropic key is write-only, and this session can't use it.
  - Today's costs are the fake model's token counts, priced at the current price table, plus infra.
  - **Real per-node costs** come from running the same sandbox on your deployment with `MODEL_LIVE = "1"`.
    The reports will say `model: real`.
- **Probes are checked, not yet run.** The planner is the only thing that asks for probes, so running
  them arrives with the planner in G4, on this same sandbox.
- **`monitoring_subscription`** has no approval and calls no tool, so "kill switch on" is its only
  failure scenario.
