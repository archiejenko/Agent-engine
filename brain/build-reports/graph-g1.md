---
type: build-report
gate: graph-G1
date: 2026-11-18
status: gate passed; two decisions for Archie (claim_site, old-runner bug)
---

# Task graph G1: compiler, interpreter, seven playbooks as graphs (gate report)

## What was built

- **The compiler** (`packages/graph/src/compiler.ts`). It's pure and deterministic, with no model calls and
  no I/O. It accepts or rejects any graph against **16 rules**:
  1. schema
  2. references
  3. connectivity
  4. loops
  5. size
  6. state flow
  7. licence lane
  8. checker before outbound
  9. untrusted content
  10. budget
  11. autonomy placement
  12. outreach checks
  13. deterministic edges
  14. reproducible hash
  15. Workflow step count
  16. Workflow-safe IDs

  Errors come back as `{rule, nodeId, message}`, so the planner (G4) gets them exactly as they are. Every
  bound comes from `graph-policy.json`.
- **The interpreter** (`packages/graph/src/interpreter.ts`). This is the one runtime for every graph:
  - a node sees only the keys it declares, and an undeclared write is refused;
  - conditional edges take the first match, and a used-up loop is skipped, so a graph can't loop forever;
  - approvals and waits pause and resume;
  - a hook before every node lets caps and kill switches pause a run (G2 wires them up).
- **All seven playbooks as graphs** (`playbooks/<name>/graph.json`; regenerate with `pnpm gen:graphs`):
  - **Six convert mechanically** and compile. Their role nodes call the **same step code** as the old
    runner, so the graph owns control flow and nothing else.
  - **`claim_site` runs only as a workflow** (`claim_fulfilment`) and has no runner steps. I converted it by
    hand from the workflow; see "Decisions for you" below.
  - **Frozen playbooks stay frozen.** `human_report`, `monitoring_subscription` and `watch_alert` are
    converted and proven equivalent, but nothing runs them through graphs.
- **The equivalence harness.** Two identical synthetic worlds: world A runs on the old runner, world B as
  graphs. The task driver (`runTaskAsGraph`) moves task status exactly as the old runner does. Nothing calls
  it at runtime yet; that comes in G2, behind `GRAPH_ENGINE_ENABLED`.

## Gate (`docs/gates/graph-g1.md`, run with `pnpm gate:graph --gate 1`)

| Criterion | Status |
|---|---|
| Each compiler rule has a failing fixture test (21 fixtures over 15 rules; the 16th, "reproducible", is a property with its own test) | passed |
| Reproducible: same spec and registry give the same hash; a new registry version changes it | passed |
| The six runner playbooks convert and compile against the live registry; `graph.json` files are current | passed |
| **Same run log as the old runner on the same fixtures** (eight scenarios below) | passed |
| `claim_site` is rejected by the compiler and keeps running unchanged on its workflow | passed (the rule works) |
| Narrowing is honest: without it the compiler refuses `sme_outreach` (rule 9) | passed |

The eight equivalence scenarios each match field by field: steps, roles, tool calls, outputs, check
results, tokens, cost, approvals, final status. They cover:
- outreach: passes first time, then **you edit it**;
- outreach: **fails the check once**, then passes on retry;
- outreach: **fails twice**, then you approve the review;
- a letter through to an approved print batch;
- a reply you **reject**;
- the three frozen L3 playbooks: human report, monitoring activation, watch alert.

**The harness caught a converter bug.** After your edit, the graph sent the original email instead of the
edited one, because the converter attached your edit to the checker's verdict instead of the draft. Fixed:
an approval node now carries every writer output.

**Tests:** `pnpm check` is green with **464 tests in 63 files**, up from 432.

## Decisions taken (please check)

1. **Rule 11 wording.** "An approval immediately before every send" and rule 12's "suppression and
   cooldown on every path into a send" can't both hold literally. I read rule 11 as:
   - an approval sits on every path into a send;
   - only deterministic check functions may sit between that approval and the send, never anything that
     could change the message.
2. **Rule 8.** Your approval doesn't replace the truthfulness checker for text a model wrote. Text *you*
   edit counts as checked, because you wrote it. This matches today's behaviour: your edits are sent as
   they are.
3. **Narrowing `sme_outreach`.** Its SKILL.md lets the research step use `web_fetch`, but the code builds
   the brief only from verified facts and never calls it. The converted graph narrows research to
   `verified_facts` (a graph may narrow tools, never widen them). That lets the compiler prove no fetched
   text reaches the send. I didn't edit the SKILL.md, because that needs a version bump and would break
   in-flight tasks. You may want to remove `web_fetch` there in the next version.
4. **Explicit outreach checks.** The converted outreach graphs gain suppression and cooldown nodes before
   each send. The send tools still check too. These two nodes don't write run-log lines in G1, which is why
   the run logs match exactly; from G2 every node logs, tagged with its node ID.
5. **Fixture masking.** The comparison masks `demo_slug` and `opt_out_code`, which are random for every
   letter by design.

## Decisions for you

1. **claim_site.** Converted faithfully from its workflow, the compiler rejects it:
   - **Rule 11 (three sends at its declared L0):** the details-form email, publishing the site and the
     domain-proposal email. Even at L1, the two emails have no approval right before them.
   - **Rule 8:** the drafted site is published with no checker reading it, only your publish review.

   This is the approved v2 design, and nothing changes: claim_site keeps running on its workflow. To bring
   it onto graphs, choose one:
   - (a) add approvals before the two emails and a checker on the site copy;
   - (b) allow a narrow, tested exemption for customer-requested transactional emails;
   - (c) leave it on the workflow.

   My recommendation is (c) now and (a) later.
2. **A bug in the old runner, on a frozen path.** When a check fails twice and you approve the review, the
   old runner resumes at "first gate + 1". For `human_report`, which has no gate, that's step 0: **it
   restarts the playbook**. I haven't touched the old runner. The graph version continues to the next step.
   No fixture hits this case. Tell me if you want the old runner fixed or left until it's retired after G2.

Next: G2, the Workflows runtime behind `GRAPH_ENGINE_ENABLED`.
