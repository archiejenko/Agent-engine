---
type: build-report
gate: graph-G5
date: 2026-11-19
status: gate passed (6 of 6, synthetic, test mode for the history); the task graph layer is complete in dry-run
---

# Task graph G5: promotion (gate report)

Evidence: `docs/gates/graph-g5.md` (`pnpm gate:graph --gate 5`).

## What it does

Trust is earned per graph **shape**, never granted per run.

- **Shape fingerprint.** A hash of a graph's node kinds, refs and edges. Per-task details (the company,
  goal text, node budgets) don't change it. Five plans for five companies share one shape.
- **Settling.** `settle_after_days` (14) after a run ends, it's settled:
  - its success metric is read from the outcome ledger (for example "replies ≥ 1" for this run's task);
  - the shape's record is updated (runs, met, breaches, cost);
  - the outcome is written back to the run. When the graph came from an opportunity, it also goes to the
    opportunity engine's outcomes, so routes can be compared by framework.
- **Only real runs count** (rules 10–12). Synthetic or dry-run runs never count towards a shape and never
  write an opportunity outcome. Sandbox and probe runs are never even looked at. The gate's synthetic
  history uses a test-only switch, and a test checks that no production file uses it.
- **Promotion.** A shape is suggested for promotion, as a **Promotion** decision in Needs you, when it
  has:
  - at least 5 runs;
  - no breaches;
  - a success rate whose Wilson lower bound (90%) is at least 60%. Five out of five gives 65%; four out
    of five doesn't qualify.

  If you approve, a promoted playbook version is written (stored in D1) and starts at **L1**. It earns
  levels like any playbook. Writing it back into `playbooks/` as a reviewed pull request comes later,
  and only with your approval.
- **Breaches.** A breach drops the shape, and its promoted playbook, one level, with an alert.
- **Caps.** The compiler already caps bespoke graphs, including every planner graph, at **L1**. A
  composed graph takes the **lowest** level among its subgraphs.
- **Behind the flag.** Settling and suggestions run in the tick only with `GRAPH_ENGINE_ENABLED` on.

## Gate criteria (all passed, synthetic)

1. The fingerprint is the same across 5 companies and for a changed goal or budgets, and different for a
   swapped ref or an extra edge.
2. **Five synthetic runs** went end to end: idea → plan → your approval → run → your draft approval →
   done (dry-run) → a reply. They settled 5/5 (success at least 65%), so a suggestion was opened. Your
   approval created `promoted_sme_outreach_…` v1 at **L1**.
3. **In production mode**, the same history counted **0** runs, recorded no shape, made no suggestion
   and wrote no opportunity outcome.
4. A breach dropped the shape and the promoted playbook from L1 to L0.
5. A planner (bespoke) graph is L1. A composed graph of `post_reply` (L0) and `monitoring_subscription`
   (L3) is L0.
6. Every settled run carries its outcome, linked to its shape. No production file uses the test-only
   switch.

## Found along the way

- **Graph runs now inherit their task's synthetic flag.** Before, a synthetic task's graph run could be
  recorded as non-synthetic. It was harmless here (those runs were dry-run, so they never counted), but
  it's fixed (rule 10).
- **A subgraph that can send is a black box to the compiler.** A composed graph must still put an
  approval and the suppression and cooldown checks around it. That's the safe reading, and I've kept it.
  The cost is that composing two sending playbooks needs those checks restated outside them.
