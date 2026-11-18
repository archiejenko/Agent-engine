---
type: build-report
plan: task-graph-layer
date: 2026-11-18
status: PLAN, waiting for Archie's OK (no code written)
---

# Task graph layer: plan for approval

I read `CLAUDE.md`, the repo and the current Cloudflare docs before writing this. Where your prompt and the
repo differ, the repo wins, as you asked; every difference is listed in section 1 with how I'd handle it.
Three of them need a decision from you before G1, and they're collected at the end (section 10).

**In one paragraph.** A graph is a JSON spec built only from node types the registry already knows. A pure
compiler accepts or rejects it, with no model involved. One interpreter runs every graph, in three modes:
- live, on a new `GraphRunWorkflow`;
- sandbox, with fakes bound in;
- probe.

The planner is a fifth role that can only submit specs and ask for probes. Everything reuses what's built:
- the tool registry and key injection;
- the recorded external effects (no repeats);
- the Budget Durable Object;
- the kill switches;
- the one decisions queue;
- the run log;
- the outcome ledger.

There are two new ledgers: `cost_events` (every penny) and `revenue_events`. The agent budget pool sits on
the Budget Durable Object, so it can never go negative. Nothing sends: dry-run stays on throughout.

---

## 1. Differences between the prompt and the repo, and how I'd handle each

| # | Prompt says | Repo has | How I'd handle it |
|---|---|---|---|
| 1 | Five playbooks | **Seven**: `sme_outreach` (L1, v2), `sme_letter` (L0), `post_reply` (L0), `claim_site` (L0), `human_report` (L3), `monitoring_subscription` (L3), `watch_alert` (L3) | G1 converts all seven to graph specs with run-log equivalence tests. |
| 2 | Convert every playbook | `human_report`, `monitoring_subscription` and `watch_alert` are **frozen revenue paths** (build nothing new on them) | Convert them as **data only**, with equivalence tests. They keep running on today's code until you unfreeze them. Converting is a refactor with zero behaviour change, but it touches frozen code, so it's your call (**decision A**). |
| 3 | agent-runner uses the Claude Agent SDK | The SDK isn't used. Playbooks call the Claude API through the `ModelClient` port (approved stack) | Keep the `ModelClient` port. The planner is one more role on it. |
| 4 | Role nodes run in the Node agent-runner in production | **Production is Workers** (v2 decision D3). The Node agent-runner is for local development; on Cloudflare the same functions run in the Worker's **queue consumer** | Role nodes are dispatched through the existing `JOBS` queue, which has a dead-letter queue. The consumer runs the role and sends the Workflow a "done" event. Locally the same handler runs in-process. Details in section 4. |
| 5 | Build a Workflows runtime | One is already built: `EngineWorkflow` runs workflow definitions (claim fulfilment), with a kill check before each step, recorded external effects and the Budget Durable Object | Add `GraphRunWorkflow` beside it, reusing those three pieces unchanged. Moving claim fulfilment onto graphs isn't in scope. |
| 6 | Event type `graph.approval.<runId>.<nodeId>` | Current docs: an event type may contain **only letters, digits, `-` and `_`**, up to 100 characters. A dot gives `workflow.invalid_event_type` | Use `ga-<runId>-<nodeId>-<iter>` for approvals and `gd-<runId>-<nodeId>-<iter>` for "node done". Run IDs are 26-character ULIDs and node IDs are capped at 40 characters (`[a-z0-9_]`) so the type always fits. The compiler enforces both. |
| 7 | Approvals on the Review page, with their own record | v3 rule 18: **one decisions queue**. Review is gone; everything that needs you is a decision in **Needs you**, resolved only through `decide()` → `owner_approvals` | Plan approvals and mid-run approvals become new decision types (`graph_plan`, `graph_node`), on the same path. The legacy `approvals` row gets `graph_id`, `graph_version`, `node_id` and `comment`, as asked, written by that same path. |
| 8 | An approval that times out counts as a reject | Rule 19: a safe default is recorded as **"defaulted"**, never as your decision | A timeout applies the safe default: don't act, pause the run. It's recorded as "defaulted", not as your reject. Same effect, honest record. |
| 9 | "Reject (reason logged as an outcome)" | Rule 12: your approve/edit/reject decisions **never feed scoring or targeting** | Your reason goes on the decision and the graph spec, and to the planner as revision feedback. It is **not** written to the outcome ledger, which trains scoring. |
| 10 | G5 gate: "a synthetic history of 5 successful runs produces a promotion" | Rule 10: synthetic data never trains or drives autonomy | Production promotion counts only real runs (not synthetic, not dry-run). The gate runs in a sandbox database through a test-only switch, marked "passed (synthetic)", the same way every v2 and v3 gate works. A test proves synthetic runs never promote in production mode. |
| 11 | Outcome write-back lets the opportunity engine learn routes | Rules 10–12 (point-in-time, ledger only) and rule 13 (the proposer never grades itself) | Write-back happens, but only real, settled outcomes count, and the planner can't read or write its own eval cases. Since this build sends nothing live, there will be no real outcomes yet. |
| 12 | `acts_externally` | The registry flags are `external` and `serves_customer` | Treat `external` as "acts externally". Compiler rule 7 checks both flags, as guardrail 1 does today. |
| 13 | The approved idea carries an expected value | **Two kinds of idea.** Opportunities have EV, a trace and facts. The 500 seeded **hypotheses** have only estimated scores and no EV | For an opportunity: suggested budget = 20% of EV, capped by the per-task cap. For a hypothesis: the explore budget from v3 decision D3 (fits the weekly explore share and spend tier; otherwise a budget decision). Seeded scores never set a budget (rule 23). |
| 14 | Ideas feed shows plan status | The Ideas feed is **v3 Phase 6** (Milestone D, on hold); today it's a placeholder | Build the feed in Phase 6 with plan status included. See the sequencing question (**decision B**). |
| 15 | Migrations up and down | Migrations are **up-only** today (0001–0019) | New graph migrations get a matching `.down.sql`. CI runs up → down → up on SQLite. D1 deploys apply only the up files; the old migrations stay up-only. |
| 16 | Gate reports in `brain/digests/` | That folder doesn't exist (daily digests live in D1). Gate reports go to `brain/build-reports/`, with evidence in `docs/gates/` | Keep the existing places: `brain/build-reports/graph-gN.md` and `docs/gates/graph-gN.md`. Say if you'd still rather have `brain/digests/`. |
| 17 | Remove the old runner "in a separate PR" | We don't open pull requests unless you ask | A separate commit after G2, or a PR if you ask for one. |
| 18 | Cost tracking from scratch | Partly built: `run_log` (tokens, cost), `tasks.cost_gbp`, `budget_events` (reservations), the `models.json` price table, `payments_ledger`, and outcome-ledger `paid`/`refunded` rows | `cost_events` becomes the single source. The existing cost fields are still written, so their tests stay green, and a test checks they reconcile with the new ledger. `revenue_events` is written in the same transaction as each settled payment or refund. |
| 19 | A monthly job reconciles infra allocations against the real Cloudflare bill | No credential reads billing, and asking for a wider token goes against the narrow-token decision (D4) | Allocate at published rates per step. Monthly: you type the bill total on the Costs page, which records an adjustment event. The automatic job comes later if you approve a read-only billing token. |
| 20 | "My top-ups" fund the pool | No top-up mechanism exists | A top-up is an action on the Costs page, recorded through the owner-approvals path as a `pool_events` row. The Budget Durable Object holds the balance (strongly consistent). |
| 21 | Sandbox model calls are real | Model calls are real only with `MODEL_LIVE = "1"` and the Anthropic key, which you haven't saved yet | Until the key is saved, the sandbox uses the fake model, and its reports say so. **G3's real-cost reports and G4's planner eval (18 of 20) need the key** (**decision B**). |
| 22 | Planner prompt in `playbooks/_planner/SKILL.md` | The loader reads every folder in `playbooks/` as a playbook | The loader skips folders starting with `_`, with a test. |
| 23 | Promotion "writes a new versioned playbook (SKILL.md plus spec)" | A Worker can't write to the git repo, and agents mustn't change the safety layer (rule 14) | Promoted playbooks are stored in D1 (`promoted_playbooks`) and run from there. Writing them back into `playbooks/` comes as a reviewed pull request later (the v3 "brain PRs" idea), only from your approval. |
| 24 | Outreach rule in the compiler (suppression + 90-day cooldown on every send path) | Already enforced inside `assessCandidates` and the send tool | Do both: the compiler rule **and** the in-tool check, so a graph can't skip it and the code doesn't trust the graph. |
| 25 | Revenue from Stripe and x402 | Stripe is test mode only; x402 isn't in scope | `revenue_events` gets test-mode rows only. **Realised profit stays £0 in this build**, so the pool is your top-ups. |

---

## 2. Repo layout changes

```
packages/contracts/src/graph/      Zod: GraphSpec, CompiledGraph, SandboxReport, GraphRun, cost/revenue events
packages/graph/                    NEW package (pure TypeScript, no I/O except through ports)
  src/registry-export.ts           node library export (kinds, refs, config schemas, cost models, flags)
  src/compiler/                    compile(spec, registry, policy) and the 14 rules + 2 more (below), one file each
  src/interpreter/                 the one interpreter: walks the topological plan; bindings decide live/sandbox/probe
  src/sandbox/                     fake bindings, scenarios, reports, probes, isolation guard
  src/fingerprint.ts               shape fingerprint
  src/costs.ts                     pricing from the versioned price table, roll-ups
packages/config/src/
  graph-policy.json                limits, sandbox caps, promotion thresholds, approval timeout
  prices.json                      versioned price table: models (moves from models.json), tool prices, infra unit rates
apps/api/src/graph-workflow.ts     GraphRunWorkflow (binding GRAPH in wrangler.jsonc), behind GRAPH_ENGINE_ENABLED
apps/api/src/graph-routes.ts       plan cards, run view, Costs page API
apps/agent-runner/src/graph-node.ts  the "run one node" job handler (Worker queue consumer + local)
apps/agent-runner/src/planner.ts   the planner role (tools: submit_graph, request_probe)
playbooks/_planner/SKILL.md        versioned planner prompt + collaboration patterns
playbooks/<name>/graph.json        each converted playbook's spec, next to its SKILL.md
evals/planner/                     20 eval opportunities; the planner job can't read or write them (rule 13)
apps/dashboard/src/                GraphView.tsx (renderer), PlanCard.tsx (in Needs you), RunView.tsx, Costs.tsx
```

Two compiler rules I'd add to your 14:
- **Rule 15:** the worst-case Workflow step count (nodes × loop iterations × fan-out items × 3 steps per node)
  must stay ≤ the policy limit, default 5,000, under Cloudflare's 10,000 per instance.
- **Rule 16:** node IDs and state keys are `[a-z0-9_]{1,40}`, so event types always fit (difference 6).

---

## 3. Workflows design (limits checked in Cloudflare's docs on 2026-11-18)

| Limit (Workers Paid) | Value | What it means for us |
|---|---|---|
| Steps per instance | 10,000 by default, up to 25,000 (`step.sleep` doesn't count) | The worst case is about 3,750 at the policy maximums; rule 15 caps it at 5,000 |
| `step.do` return value | 1 MiB | Steps return only **references**. State values go to D1 |
| Persisted state per instance | 1 GB | Not a constraint |
| Step timeout | keep each `step.do` under 30 minutes; use `waitForEvent` for longer waits | Role nodes are dispatched and then waited on (section 4), never run inside a step |
| CPU per invocation | 30 s by default, configurable to 5 minutes | Interpreter work is milliseconds; model calls happen in the queue consumer |
| `waitForEvent` timeout | 1 second to 365 days; default 24 hours. **On timeout it throws and the instance fails** unless caught | Every wait is wrapped. A timeout applies the node's safe default and pauses the run, rather than failing it |
| Event type | `[A-Za-z0-9_-]`, up to 100 characters; **no dots** | Naming in difference 6 |
| Event timing | An event sent before the matching `waitForEvent` is buffered and delivered when the instance reaches it | A role node that finishes before the Workflow starts waiting isn't lost |
| `sendEvent` | Throws if the instance isn't running or has errored | The sender records the event in D1 first; the Workflow checks D1 on resume (a belt-and-braces replay) |
| Instance retention | 7 days by default, up to 30 | Our D1 tables are the long-term record; the Workflow's own state is disposable |
| Concurrency | 50,000 instances per account; waiting instances don't count | Not a constraint |

**How a run works:**
1. `GraphRunWorkflow.run({ graphId, version, runId, mode })` loads the compiled graph by `graphId@version`
   from D1, checking its content hash. No code is generated per graph.
2. For each node in topological order, step `pre:${nodeId}#${iter}` checks, in order:
   - the kill switches (global and playbook);
   - the pool balance;
   - the global and playbook daily caps;
   - the per-graph budget.

   It reserves the node's worst case in the Budget Durable Object. A failed check pauses the instance and
   raises an alert with a decision.
3. The node's own step, `${nodeId}#${iter}`, depends on its kind:
   - **function, condition, join:** runs inline (deterministic).
   - **tool:** goes through the tool registry. External tools are recorded in `external_effects` before
     they run, so a replay never repeats them; keys are injected on live calls only.
   - **role:** dispatched (section 4).
   - **approval:** `waitForEvent('ga-…')` with a 7-day timeout.
   - **wait:** `step.sleep` or `waitForEvent`.
   - **subgraph:** inlined at compile time as a namespaced subgraph, so one instance runs one graph.
   - **fanout:** parallel `step.do` calls in batches no wider than the node's width.
4. Afterwards, step `post:${nodeId}#${iter}` settles the reservation, writes one `cost_events` row per model
   or tool call, and adds the node's line to the run log, tagged with `graph_id`, `graph_version` and
   `node_id`.
5. **Large state** goes to the `graph_state_values` table in D1 (run, key, iteration, value, untrusted,
   lane), and only references pass between steps. A single value is capped at 512 KB in code; I still have
   to confirm D1's maximum row size at G2. R2 isn't needed for G0–G5; I'd add it only if a real value
   outgrows D1.
6. **Reproducibility:** each model output is stored per node run. A replay uses the stored output, so the
   same compiled hash, inputs and config versions give the same run.

---

## 4. Role nodes: Workflow → queue consumer → back

- **Transport.** Inside step `${nodeId}#${iter}`, the Workflow sends a `graph_node` job to the existing
  `JOBS` queue: run ID, node ID, iteration and an idempotency key. It then waits for
  `gd-<runId>-<nodeId>-<iter>`. In production the queue consumer is the Worker (Workers is production; the
  Node agent-runner is for local development). Locally, the same handler runs in-process, behind the same
  interface.
- **What the consumer does:**
  1. It loads the role's prompt and **only the state keys the node declares** (rule 3).
  2. Untrusted keys reach the operator role or an external tool only after a writer and a checker; the
     compiler guarantees this.
  3. It runs the role step on today's code (ModelClient, tool registry, checker).
  4. It writes outputs, the recorded model output and cost events to D1.
  5. Then it calls `instance.sendEvent(gd-…)`.
- **Idempotency.** `graph_node_runs` has one row per run, node and iteration. If the job arrives twice, the
  consumer sees the row is already done and just re-sends the event.
- **Retries.**
  - The queue retries up to 3 times (60 seconds apart, as today), then sends the job to the dead-letter
    queue, which raises a decision in Needs you.
  - On the Workflow side, the node's `retry.max` and `backoffS` apply. A retried node reuses its
    idempotency key, so a finished model call is never paid for twice.
- **Timeouts.** The Workflow waits for the node's `maxDurationS` plus 2 minutes, capped at 30 minutes in
  policy. A timeout re-dispatches up to `retry.max` times, then pauses the run with a decision. A queue
  consumer can use up to 15 minutes of CPU; time waiting for the model isn't CPU time.

---

## 5. Storage tables and migrations (each with a matching `.down.sql`)

**0020_graph_core**
- `graph_specs`:
  - graph_id, version, parent_version, task_id, opportunity_id, hypothesis_id;
  - spec (json), content_hash, registry_version, compiled (json);
  - lane, worst_case_cost_gbp, autonomy, shape_fingerprint;
  - status (drafting / probing / sandboxing / ready / approved / running / done / rejected / couldnt_plan);
  - attempt, created_at, created_by;
  - unique (graph_id, version).
- `sandbox_reports`:
  - id, graph_id, version, attempt, scenario, as_of, pass;
  - report (json), sandbox_cost_gbp, projected_live_cost_gbp, run_id, mode (sandbox | probe), created_at.
- `graph_runs`:
  - run_id, graph_id, version, instance_id, mode, status, cost_so_far_gbp;
  - started_at, ended_at, outcome_id, synthetic.
- `graph_node_runs`:
  - run_id, node_id, iteration, status, started_at, ended_at, cost_gbp;
  - output_ref, recorded_model_output, check_results, error;
  - unique (run_id, node_id, iteration).
- `graph_state_values`: run_id, key, iteration, value, untrusted, lane.
- New columns on `approvals`: graph_id, graph_version, node_id, comment.
- New columns on `run_log`: graph_id, graph_version, node_id.

**0021_cost_ledgers**
- `cost_events`, append-only:
  - event_id, at, run_id, graph_id, graph_version, node_id, task_id, opportunity_id;
  - revenue_path, shape_fingerprint;
  - mode (sandbox | probe | planner | live), category (model | tool | infra | third_party);
  - unit, quantity, unit_price, amount_gbp, price_table_version;
  - synthetic, dry_run.
- `revenue_events`, append-only:
  - event_id, at, run_id, task_id, opportunity_id, revenue_path, rail (stripe | x402);
  - reference, amount_gbp (negative for refunds), settled_at, test_mode.
- `pool_events`: top-ups and adjustments; a top-up carries its owner approval ID.

**0022_graph_shapes**
- `graph_shapes`:
  - fingerprint, first_seen;
  - live_runs, met_metric, breaches, total_cost_gbp;
  - autonomy, promoted_playbook, promoted_version.
- `promoted_playbooks`: name, version, spec, skill_md, approval_id, created_at.

**Rules that apply across the tables:**
- No code outside `packages/storage` touches these tables, as today.
- Roll-ups are SQL plus TypeScript over `cost_events` and `revenue_events`; nothing is stored twice.

---

## 6. Graph rendering: no library

My recommendation is to draw the graph ourselves in SVG, laid out from the compiler's own topological
layers. No React Flow, no dagre. Reasons:
- **The size is bounded.** Graphs are capped at 25 nodes and depth 10, and the compiler already computes the
  layers. A layered top-to-bottom layout is about 150 lines we own and can test.
- **You only judge, never edit.** React Flow's strength is interactive editing, panning and zooming. That
  isn't needed here, and dragging and panning fight the phone-width, no-sideways-scroll test.
- **It's the boring choice.** No new framework, which v3 asks for, and no layout drift between versions.
  The phone layout test covers it like every other page.

The view will show:
- the graph runs top to bottom, one layer per row, wrapping on a phone;
- each node coloured by kind: agent, deterministic, or needs you;
- externally acting nodes marked;
- loop edges labelled with their maximum iterations;
- in the run view, each node's state and cost.

If you later want to edit graphs by hand, React Flow plus dagre is the upgrade path.

---

## 7. Tests for each gate

Every gate also re-runs `pnpm check`: every existing test, all eight guardrails and v2/v3 rules 9–23.

**G0 · Contracts and storage** (no runtime change)
- Each graph schema accepts a valid example and rejects one bad example per field rule (enum without
  values, back-edge without `loop`, planner-set `lane`, and so on).
- Migrations 0020–0022 run up, down, then up again on SQLite, with the schema identical after.
- `/api/health` shows 22.
- The registry export lists every registered tool, role and function with its config schema, cost model and
  flags. A static test checks it against the live registry.
- The price table loads through Zod. One model call priced from reported token usage matches a hand
  calculation.
- Behaviour is unchanged: every existing gate is re-run, with identical run logs on the standard fixtures.

**G1 · Playbooks as graphs**
- At least one failing fixture per compiler rule (1–16), each giving the expected structured error
  `{rule, nodeId, message}`.
- The same spec and registry version always give the same compiled hash.
- All seven converted playbooks compile.
- On the same fixtures, the interpreter in dry-run produces **the same run log** as the old runner: steps,
  tool calls, approvals, outputs and cost.
- A graph that asks for a tool, lane or limit beyond its registry entry is rejected (rule 4).
- No edge is evaluated by a model: the interpreter has no model dependency (a static test).

**G2 · Workflows runtime** (`GRAPH_ENGINE_ENABLED`, dry-run)
- `sme_outreach` runs end to end on `GraphRunWorkflow`, with its approval resolved from Needs you. This is a
  local test plus one `wrangler dev` run.
- The kill switch stops a running instance before its next node.
- A forced failure after an external step resumes without repeating it (`external_effects`).
- An approval timeout applies the safe default, pauses the run, and is recorded as "defaulted", with no
  owner approval.
- A node finishing before the Workflow waits for it (buffered event) still completes. A duplicated queue
  job doesn't run the node twice.
- Cost:
  - every model and tool call in a fixture run produces exactly one cost event;
  - roll-ups equal the sum of their events;
  - an empty pool pauses a running graph before its next step;
  - spending crosses the 50%, 80% and 100% thresholds and each raises exactly one alert.
- Legacy cost fields (`run_log`, `tasks.cost_gbp`) reconcile with `cost_events`.

**G3 · Sandbox**
- **Isolation:** in sandbox mode the registry refuses every live adapter. A test tries each external tool
  and each port, and the build fails if any live adapter is reachable.
- Every converted playbook has a sandbox report with per-node cost, for the happy path and at least one
  failure scenario (no reply, tool error, payment).
- Sandbox and probe spend never appear as live spend.
- Probes: no more than 5 nodes, read-only, no operator, no external tools; their cost counts against the
  sandbox cap.
- Every report and card carries the line "Sandbox proves mechanics and cost, not demand".
- *Needs the Anthropic key for real costs; without it, reports are labelled "fake model".*

**G4 · Planner**
- At least 18 of 20 eval opportunities produce a compiling, within-budget graph in 3 attempts or fewer.
  Results are scored for reuse of playbooks and sandbox passes.
- A new prompt version must not do worse than the last.
- **The planner never receives raw fetched content:** a canary page and email are planted, and every planner
  request is scanned for them.
- The planner can't:
  - raise its budget;
  - mark its own graph approved;
  - request a tool outside the registry;
  - run a third probe or a fourth attempt.
- After the third failure the idea shows "couldn't plan", with every report attached.
- The approval card shows every field in your Dashboard list (the render test checks each one) and passes the
  phone layout test.
- Edit sends your comment back and uses an attempt. Reject records your reason on the decision, not in the
  outcome ledger.
- *Needs the Anthropic key.*

**G5 · Promotion**
- The shape fingerprint ignores per-task config and changes when a kind, ref or edge changes.
- A synthetic history of 5 successful runs produces a promotion suggestion (test mode only). Approving it
  creates a promoted playbook version at L1.
- In production mode, synthetic or dry-run runs never count.
- A breach drops a shape or playbook one level.
- A bespoke graph never runs above L1. A composed graph takes the lowest level among its subgraphs.
- Each finished run writes an outcome linked to its shape and opportunity. Only real, settled outcomes count
  (rules 10–12).

---

## 8. What I'd change in the prompt, and why

1. **Event naming** (forced by the docs): dashes, not dots (difference 6).
2. **Approval timeout**: record it as "defaulted", not as your reject (rule 19). The effect is the same.
3. **Your reject reason doesn't go to the outcome ledger** (rule 12), so your judgement never trains
   scoring.
4. **No graph library** (section 6).
5. **No R2 for now**: D1 covers every value we'll have; add R2 only when one outgrows it.
6. **Promotion threshold.** Five successes with no breaches is a thin record, so a lucky streak would
   promote. I'd add a second test in policy: the lower bound of the success rate (Wilson, 90%) must be at
   least the playbook's target. With 5 out of 5, the lower bound is about 0.65. You set the target.
7. **Pool enforcement**: put the pool in the Budget Durable Object and reserve before every spend. A model
   call can't be stopped halfway, so checking afterwards could take the balance below zero.
8. **Sequencing** (decision B, below): G4 and G5 overlap Milestone D Phase 6. I'd treat G2–G5 as the agent
   half of Milestone D, so there's one plan, not two.
9. **Model choice** stays as it is: Opus 5.5 for every role, the planner included. The cost in section 9
   assumes that. Moving research and checking to a cheaper model would roughly halve the run costs, but
   that's your decision and I haven't changed it.

---

## 9. Estimated monthly running cost at 50 tasks a week (about 217 a month)

Prices checked on 2026-11-18:
- **Cloudflare:** Workers Paid $5 a month (you already pay it). Workflows include 500,000 steps, 30 million
  CPU-ms and 1 GB-month of storage. D1 includes 25 billion rows read, 50 million rows written and 5 GB.
- **Claude Opus 5.5:** $4 per million input tokens and $20 per million output tokens (cache reads $0.20).
  These match `models.json`, and £ uses its 0.79 rate.
- **Token counts are my estimates.** G3 replaces them with measured numbers.

| Item | Assumption | Per month |
|---|---|---|
| Workflows steps | about 25 per live run + about 60 per idea planned | about 7,000 (500,000 included) → **£0** |
| Workflows CPU and storage | milliseconds per step; 7-day retention | **£0** |
| D1 writes and storage | about 200 rows per task (cost events, node runs, state, run log) | about 45,000 (50 million included) → **£0** |
| R2 | not used | **£0** |
| Live run model spend | 3 role nodes × about 6k tokens in + 1.5k out ≈ $0.16 a task | 217 × £0.13 ≈ **£28** |
| Planner | about 15k in + 8k out per attempt, about 1.5 attempts per idea ≈ £0.28 per idea | at 5 new ideas a week (22 a month) ≈ **£6** |
| Sandbox | 2 scenarios × 1.5 attempts, each about one run's model cost ≈ £0.38 per idea | 22 × £0.38 ≈ **£8** |
| Probes | about 1 per idea, small | 22 × £0.08 ≈ **£2** |
| **Total, expected** | 50 tasks a week, mostly on existing playbooks; 5 new ideas planned a week | **about £44 a month**, plus the $5 Workers plan you already pay |
| **Worst case** | every task a newly planned bespoke graph | about £28 + 217 × £0.74 ≈ **£190 a month** |

The policy caps (£2 per sandbox attempt, £5 per graph) and your daily global cap bound the worst case; the
pool stops everything at £0.

---

## 10. Decisions I need before starting

- **A. Frozen playbooks in G1.** Convert `human_report`, `monitoring_subscription` and `watch_alert` as data,
  with equivalence tests, but leave them running on today's code? *(My recommendation: yes; it changes
  nothing they do.)* Or leave them out of G1 until you unfreeze them?
- **B. Sequencing with Milestone D.** Your earlier instruction holds Milestone D until the keys are saved and
  Stage 5 (20 real drafts) is reviewed. My recommendation:
  1. G0 and G1 now: nothing changes at runtime, and no key is needed.
  2. Then Stage 5 when you confirm the keys.
  3. Then G2 and G3.
  4. Then Phase 6 (Ideas feed and Board, with plan status built in).
  5. Then G4 and G5. These replace the agent and autonomy parts of Milestone D Phases 7–10, as v3 replaced
     v2 Milestone B.

  I'd update `CLAUDE.md` and the v3 plan to match. **G3's real costs and G4's eval need the Anthropic key.**
- **C. Gate reports**: keep `brain/build-reports/` and `docs/gates/` (my recommendation), or use
  `brain/digests/` as the prompt says?

Out of scope, as you listed, and kept out:
- a knowledge-graph vault, a graph view of `brain/`, and GraphRAG;
- code-generating nodes or any new node kind;
- LangGraph or any other orchestration framework;
- changes to verification or opportunity scoring;
- licensed data;
- any live send.

**Nothing is built until you OK this plan.** After your OK, I'll work through the gates without stopping, in
the order you choose in B, writing a report at each gate, and staying in dry-run throughout.
