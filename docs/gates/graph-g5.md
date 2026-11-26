# Phase graph-g5 gate report

Generated 2026-11-26T20:43:49.515Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| The shape fingerprint ignores per-task config and changes when a kind, ref or edge changes | passed (synthetic) | 5 plans for 5 different companies share 1 shape(s) (be8833f072b2); another task, goal and budgets: same; a swapped ref: different; an extra edge: different |
| A synthetic history of 5 successful runs produces a promotion suggestion (test mode); approving it creates a promoted playbook version at L1 | passed (synthetic) | 5 runs done (dry-run), each with a reply; settled: 5/5 met "count_replies ≥ 1"; shape record 5/5, 0 breaches, success at least 65% (Wilson, z 1.645; needs 60%); suggested; Archie promoted it: promoted_sme_outreach_be8833f0 v1 at L1 |
| In production mode, synthetic or dry-run runs never count | passed (synthetic) | the same 5-run history settled in production mode: 0 counted (synthetic: never counts); shapes recorded: 0; suggestions: 0; opportunity outcomes written: 0 |
| A breach drops a shape or playbook one level | passed (synthetic) | shape L1 → L0; promoted_sme_outreach_be8833f0 L1 → L0 |
| A bespoke graph never runs above L1; a composed graph takes the lowest level among its subgraphs | passed (synthetic) | planner graph (bespoke): L1; composed of post_reply (L0) and monitoring_subscription (L3): L0 (lowest: L0) |
| Each finished run writes an outcome linked to its shape; only real, settled outcomes count | passed (synthetic) | 5 runs carry their outcome (met/missed + shape); outcomes become counted records only for real, settled runs (criterion 3); the test-only switch appears in no production file (61 scanned) |

Synthetic data, fakes only, dry-run, kill switch on. Nothing external happened.
