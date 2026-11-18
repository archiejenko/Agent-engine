---
type: build-report
gate: graph-G0
date: 2026-11-18
status: gate passed; no runtime change
---

# Task graph G0: contracts and storage (gate report)

## What was built

- **Contracts** (`packages/contracts/src/graph.ts`):
  - the graph spec, node, edge and state field;
  - the compiled graph, sandbox report and graph run;
  - the extended approval record;
  - the cost, revenue and pool events;
  - the decision log entry.

  A spec is strict: an extra field anywhere is refused, so a graph can't carry code or ask for
  permissions. A state field can't set its own lane. Node IDs are snake_case and at most 40 characters, so
  Cloudflare event names (letters, digits, `-`, `_`) always fit.
- **Storage** (migrations 0020–0022, each with a down file):
  - graph specs, sandbox reports, runs, node runs, state values;
  - the **decision log**;
  - shapes, promoted playbooks;
  - the **cost, revenue and pool ledgers**.

  The three money ledgers are append-only, enforced in the database. The down files live in
  `packages/storage/migrations-down/`, because Wrangler applies every `.sql` file in the migrations folder
  it deploys.
- **Decision log (your addition 1).** Your reject, edit and question reasons go in their own table. The
  planner reads it when revising (G4) and its eval reads it. It is never part of the outcome ledger, so your
  judgements never train scoring (rule 12).
- **Price table (your addition 2).** I checked it on 2026-11-18 against Anthropic's live pricing page
  (https://platform.claude.com/docs/en/about-claude/pricing). The page shows no "last updated" date.

  | Model | Input | Output | Cache read | In config before | Now |
  |---|---|---|---|---|---|
  | Opus 5.5 | $4 | $20 | $0.20 | input/output matched | cache prices added |
  | Sonnet 5.5 | $2 | $10 | $0.10 | matched | cache price added |
  | Haiku 5.5 | $0.10 | $0.50 | $0.01 | matched | cache price added, plus the tier for prompts over 100k tokens ($0.50 / $2.50) |

  Cache writes added: 1.25× input for 5 minutes, 2× for 1 hour. The table now carries
  `price_table_version: 2026-11-18`, stamped on every cost event. Cloudflare unit rates for infra allocation
  are in `infra-prices.json`, also checked 2026-11-18.
- **Pricing in code** (`packages/graph/src/costs.ts`). A model call is priced from the token usage the API
  reports, never from estimated tokens, with cache reads and writes and the long-prompt tier. Roll-ups are
  sums of events.
- **Node library export** (`packages/graph/src/registry-export.ts`). It's built from the **live** tool
  registry and lists:
  - 12 tools (5 act externally);
  - 4 roles;
  - 8 registered deterministic functions;
  - all 7 playbooks;
  - the policy limits.

  Its hash is the registry version.
- **Graph policy** (`packages/config/src/graph-policy.json`). Every bound lives here: sizes, loops, fan-out,
  steps, sandbox caps, approval timeout, budget share and promotion thresholds, including the Wilson lower
  bound I suggested in the plan.

## Gate (`docs/gates/graph-g0.md`, run with `pnpm gate:graph --gate 0`)

| Criterion | Status |
|---|---|
| Schemas: a valid spec passes; setting a lane, smuggling code, requesting permissions or misnaming nodes fails | passed |
| Migrations 0020–0022 run up, down and up again (schema compared column by column) | passed |
| The node library export lists every registered tool, role and function, deterministically | passed |
| The price table matches the live pricing page (checked 2026-11-18); a priced call matches a hand calculation | passed |
| Your reasons live only in the decision log; the money ledgers can't be edited or deleted | passed |
| No runtime change: no runtime file imports the graph layer | passed |

**Tests:** `pnpm check` is green with **430 tests in 59 files**, up from 403. Every v1–v3 gate test is
included.

## Decisions taken

- Down files sit outside the deployed migrations folder (above).
- Run IDs are 32 hex characters (a UUID without dashes) rather than ULIDs. That needs no new library, and
  event names stay under 100 characters.
- The node library export lists the operator role's model as "none", because operators never call a model.

## Open questions

None for G0.

Next: G1, the compiler, the dry-run interpreter, and all seven playbooks as graphs. Stage 5 runs on your
deployment when you approve leads; see the note at the end of the G1 report.
