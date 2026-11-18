---
type: build-report
gate: graph-G2
date: 2026-11-18
status: gate passed (9 of 9, synthetic, dry-run); flag off by default; old runner kept (see below)
---

# Task graph G2: the Workflows runtime (gate report)

Evidence: `docs/gates/graph-g2.md` (`pnpm gate:graph --gate 2`). Everything ran on synthetic data, with
the fake model, in dry-run. Nothing external happened.

## What was built

- **`GraphRunWorkflow`** (`apps/api/src/runtime-worker.ts`) runs graphs on Cloudflare Workflows. It sits
  beside `EngineWorkflow` and reuses its step adapter, its recorded external effects and the Budget
  Durable Object.
  - Locally, the same `graph_run` definition (`packages/infra/src/graph-runtime.ts`) runs on the existing
    persisted-step engine, so the gate tests the code that runs in production.
- **Behind a flag.** `GRAPH_ENGINE_ENABLED` is a new Worker var. It's empty by default, which means the
  old runner does exactly what it did before. Set it to `"1"` and `sme_outreach` runs as a graph.
  - Only `sme_outreach` is switched for now (the list is in config, `graphEngine.playbooks`). The frozen
    playbooks stay on the old runner.
- **Role nodes run in the queue consumer.** Each one goes out as a `graph_node` job on the existing
  `JOBS` queue, which has a dead-letter queue. When it finishes, it sends the Workflow a "done" event
  (`gd-…`).
  - A retried job never repeats a finished node, because the node's result is recorded first.
- **Approvals** wait with `waitForEvent` (`ga-…`), with a 7-day timeout. They appear in **Needs you** as
  ordinary draft decisions and resolve through the one decisions path.
  - If nobody answers, the safe default applies: nothing is sent. It's recorded as "defaulted", never as
    your approval.
- **Before every node** the run checks four things, in order, and pauses if any is set:
  - the queue pause;
  - the playbook's kill switch;
  - the graph's budget;
  - the agent pool (only when the model is real).

  While paused, it sleeps and re-checks every 5 minutes. The global kill switch keeps its existing
  meaning: external tools run dry.
- **Cost ledger.** Every model call and every tool call writes exactly one cost event, and every node
  writes one infra event. Roll-ups are sums of events.
  - Budget alerts fire at 50%, 80% and 100%, each once.
  - Fake-model costs are marked synthetic and never count as real spend.
- **State-size cap enforced.** A node may write at most 512 KiB per state value. I checked the current
  Cloudflare limits on 2026-11-18:
  - D1: 2,000,000 bytes per row;
  - Workflows: 1 MiB per step result.

  The cap fits under both. A node that writes more fails before anything is stored. This has a test.

## Gate criteria (all passed, synthetic)

1. `sme_outreach` runs end to end on the graph runtime. The approval is resolved through
   `POST /api/decisions/:id/decide`, and one dry-run email results.
2. There is exactly one cost event per model or tool call, and the per-node roll-up equals the sum.
3. The kill switch pauses a run before its next node, and clearing the switch resumes it.
4. A crash right after the send step: the retried job finds the recorded result, and there's still one
   email, not two.
5. An unanswered approval is cancelled safely after 7 days and isn't counted as your approval.
6. An empty pool (with real spend) pauses the run before its first model step, and a top-up lets it
   continue.
7. Budget alerts fire at 50% and 80%, and checking again raises none.
8. With the flag off, the old runner handles the task.
9. The Worker builds with the `GRAPH (GraphRunWorkflow)` binding (`wrangler deploy --dry-run`).

The fifth G2 cost test, "sandbox spend never appears as live", belongs to G3. It's next.

## Changed along the way

- **The G0 "no runtime change" check now reads "no runtime change by default".** It confirms three
  things:
  - the runner service is the only app file that imports the graph layer;
  - the flag is off by default;
  - the Worker var is empty.

  The G0 evidence was regenerated.

## Not done, and why

- **The old runner isn't removed.** The plan said "a separate commit after G2". I've held it back:
  - Your deployment still runs on the old runner, because the flag is off.
  - Stage 5 and the frozen playbooks depend on it.
  - The graph runtime reuses its step code, so "removing" it would only delete the old loop. That would
    leave a deployment with the flag off unable to run tasks at all.

  I'd remove the loop once you've switched the flag on in production and seen real `sme_outreach` runs
  on it. If you'd rather it went now, say so; it's a small commit.

## What you'd do to try it on Cloudflare (optional, dry-run)

Run `pnpm cf:deploy`, set `GRAPH_ENGINE_ENABLED` to `"1"` in `apps/api/wrangler.jsonc` (or as a
dashboard var), and deploy again. New `sme_outreach` tasks then run as graphs, and their approvals
appear in **Needs you** as before. Set it back to `""` to return to the old runner.
