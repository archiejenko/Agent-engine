---
type: build-report
gate: graph-G4
date: 2026-11-19
status: gate passed (8 of 8, synthetic, fake planner model); the real planner eval runs on your deployment
---

# Task graph G4: the planner (gate report)

Evidence: `docs/gates/graph-g4.md` (`pnpm gate:graph --gate 4`).

> Sandbox proves mechanics and cost, not demand.

## What it does

When you **pass** an idea, the planner designs the route to its outcome as a task graph. It may first run
up to 2 small read-only probes. Then:

1. It submits a graph.
2. The compiler accepts or rejects it.
3. The sandbox runs it: the happy path and its failure scenarios, each in a fresh throwaway database.

If any of those fails, the planner gets the errors and reports back as structured data and tries again,
up to **3 attempts**. A plan that compiles and passes the sandbox becomes a **Plan** decision in Needs
you. After three failures the idea shows **"couldn't plan"**, with every report attached.

- **Prompt.** The planner's prompt is versioned in `playbooks/_planner/SKILL.md` (v1). It documents the
  five collaboration patterns: pipeline, fan-out with a join, writer and checker loop, router, playbook
  as a subgraph. It's bundled for the Worker like the playbooks.
- **What it's given** (structured only):
  - the idea card;
  - the node library;
  - the playbook catalogue, with each converted graph;
  - policy limits;
  - a **suggested budget** computed in code: 20% of expected value per task, capped by the per-task
    limit;
  - on a revision, the compiler's errors, the sandbox report, probe reports and your comments from the
    decision log.
- **What it can't do** (enforced in code, not asked of it):
  - **raise its budget:** the compiler's cap *is* the suggested budget;
  - **approve its graph:** code sets the id, version and status, and an extra "status" field fails the
    schema;
  - **use anything outside the registry:** the compiler's references rule;
  - **run a third probe or a fourth attempt.**
- **The approval card** (`#/plans/<id>`, linked from Needs you and from the idea):
  - the graph, drawn from the compiler's layers, coloured agent / deterministic / needs you, with
    externally acting nodes outlined in red;
  - the goal, success metric and stop conditions;
  - the budget beside expected value and the worst case;
  - the autonomy level;
  - the sandbox result per scenario and node, with guardrail hits;
  - probe reports;
  - the diff against the previous attempt;
  - the note above;
  - **Approve / Edit / Reject.**
- **Your decision:**
  - **Edit:** your comment goes to the planner and uses an attempt.
  - **Reject:** your reason is kept.

  Both go to the decision log, never the outcome ledger.
- **An approved plan** gets one task, which runs that exact compiled graph on the graph runtime, in
  dry-run. Its approvals come to Needs you as before.
- **Behind the flag.** Planning, and running approved plans, only happen with `GRAPH_ENGINE_ENABLED`
  on, like every graph run. Off, nothing changes.
- **Costs.** Every planner call writes a cost event with mode "planner", so you can see what deciding
  costs per idea. With the fake model, it costs £0 and shows the projected price.

## Gate criteria (all passed, synthetic)

1. **18 of 20** eval ideas produce a compiling, within-budget graph in 3 attempts or fewer.
   - Playbook reuse 90%; sandbox pass 90%.
   - The two misses are the licensed-source cases. The planner can't produce a runnable outreach graph
     for licensed data, and it correctly can't.
2. **No regression.** Prompt v1 is recorded at 18/20 in `evals/planner/baseline.json`. A later version
   must do at least as well.
3. **Canaries.** A canary web page, a canary email and canary hidden scout text were planted. 42 planner
   requests were scanned, and none carried any of them.
4. **The planner's limits held.**
   - "status: approved" was refused.
   - A £50 budget was refused every time (cap £0.40).
   - An unregistered `send_sms` tool was refused.
   - Probe 3 was refused.
   - A planner that always fails was asked exactly 3 times.
5. **"couldn't plan"** shows after the third failure, with all 3 reports.
6. **Edit and reject.**
   - Your edit comment reached the planner, and the revision became a new version.
   - Your reject reason is in the decision log and the owner-approval record (the record of your
     decision), and not in the outcome ledger.
7. **An approved plan ran as a graph** and stopped at its approval node.
8. **The approval card** returns all 13 fields. The phone-width render test checks each label and the
   three buttons.

The eval set is in `evals/planner/cases.json`: 20 synthetic ideas across sme_outreach, sme_letter and
post_reply, plus 2 from a licensed source. Under rule 13, the planner's code can't read that folder, and
a static test checks it.

## Limits, and what needs you

- **The planner here is a deterministic stand-in** (`fake-planner.ts`). It reuses the named playbook's
  graph, over-asks on budget on its first try, and fits the cap on the second. The **real planner**
  (the `planner` role, Opus 5.5 at high effort) runs when `MODEL_LIVE = "1"` and your key is saved. Run
  `pnpm gate:graph --gate 4` on your machine with those set to get real eval numbers and planning costs.
  A real result below 18/20 means the prompt needs work before it's used.
- **Planning runs in the Node runner, not on Workers yet.** Each sandbox run needs a fresh throwaway
  database. Locally that's an in-memory SQLite. On Cloudflare it needs a separate sandbox D1 database.
  **Your call:** should I add a sandbox D1 database (free tier, one more binding) so planning can run on
  Workers? Until then, run the tick locally with `GRAPH_ENGINE_ENABLED=1`.
- **Not built yet:**
  - the Costs page (spend today against the cap, pool balance, top runs and shapes);
  - the live run view (node states, cost so far, Pause and Kill per run).

  The data for both exists in the cost ledger and the run tables. I'd add them next to G5, unless you'd
  rather wait.
