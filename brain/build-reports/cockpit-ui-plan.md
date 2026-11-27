---
type: plan
date: 2026-11-26
status: U1 approved; U2 built (see brain/build-reports/cockpit-u2.md); waiting at the U2 gate
---

# Agent Engine cockpit UI: plan (maximum visibility, judge-only)

**No UI code has been written.** This plan turns the 26 November design conversation into a build. When
you approve, I build Phase U1 and stop at its gate. Each phase after that waits for your approval.

Starting point: branch `claude/nifty-curie-91l1nq` at `2383bc4`.

---

## 0. What you asked for

- **The goal.** Maximum visibility, highly visual, full context. You come in as the judge, deal with
  only what needs you, and leave.
- **The 10-second test.** Within 10 seconds Home answers three questions:
  1. Am I making money?
  2. What needs me?
  3. Is anything burning cash or broken?
- **Order on Home:** brief → KPIs → Needs you → money → agent activity → health. The filters drop to
  one compact bar.
- **Full context through drill-down, not density.** Every number opens the rows behind it, for example
  revenue → playbook → customer → the run that earned it, or spend → agent → graph → model call.

### OpenUI: looked at, not adopted

OpenUI (generative UI from Thesys) was installed and reviewed against this repo. **Decision: don't use
it.** Your judgement was that it's unnecessary, and the code check agrees.

- **The model would do maths.** Its dashboards run model-written scripts, which breaks rule 4 (all
  maths in code).
- **Data would leave the Worker.** When a generated script runs, data-tool results are sent to Thesys's
  servers (`/v1/app/execute`, read in `@openuidev/server` 0.5.3).
- **It would add a third-party key** (`THESYS_API_KEY`) and a vendor cloud that stores the dashboards.
- **It doesn't fit the use case.** It's built for products where end users ask for dashboards nobody
  designed. Here there's one user and the data is known.

**What we copy instead, as our own code:**

1. **Layout as data.** The layout is described in a JSON file, checked when it loads (§3.1).
2. **One registry of read-only data functions** with known output shapes (§3.2).
3. **Panels load on their own.** Each has its own loading, error and refresh state (§3.3).
4. **Their component vocabulary:** KPI with change vs the previous period and a goal or range, Funnel,
   Leaderboard, Segmented bar, Heatmap, Small multiples, and a filter bar with a period picker and a
   compare toggle (§3.3).

---

## 1. Starting point (what exists today)

- **Pages.** Seven pages (Home, Ideas, Board, Vault, CRM, Inbox, Controls) in a hash router
  (`apps/dashboard/src/App.tsx`).
- **Styling.** Plain CSS, light theme only, 1100 px wide (`styles.css`). No chart library.
- **Home today.** In this order: `NeedsYou`, `Digest`, filter row, then tiles from `/api/home`, then
  two collapsed sections (`Overview`, `Metrics`).
  - It makes one request for every tile. One failure turns the whole page red, as in the 26 November
    screenshot (`access_not_configured`).
  - That error was the Access vars missing from the deployed Worker. They were added on 26 November.
    The 22:02 deploy published the Worker, then failed its "still behind Access" check. That's a
    Cloudflare Access app setting, not a UI issue, and needs fixing before anything else.
- **Data already there.** Almost every panel below already has a source:

| Data | Source today |
|---|---|
| 11 Home figures, each labelled real/estimated/assumed/dry run/simulated, with a 95% range where measured | `homeFigures` (`packages/infra/src/analytics.ts`), `/api/home` |
| Revenue, cost and runs per day by playbook, separating live, simulated and dry-run | `daily_rollups` (data layer step 4) |
| Top-ups to the agent money pool | `pool_events` (append-only) |
| Open decisions, with money at stake, options and safe default | `/api/decisions` (rule 18) |
| Daily digest | `/api/digest` |
| Heartbeats, dead letters, uncertain effects, workflows, triggers | `/api/runtime` |
| Caps, spend today per playbook, refusals | `/api/budgets` |
| Kill switches, autonomy, playbook stats, alerts | `/api/controls` |
| Idea cards with status and economics; Board tiles | `/api/ideas`, `/api/board` |
| Companies by stage | `/api/crm` |
| Key status | `/api/keys` |

- **Caching.** A 60-second KV cache sits in front of `/api/home`, `/api/economics`, `/api/board` and
  `/api/crm`. Spend caps and Budgets are never cached.
- **Mobile test.** `tests/mobile-layout.test.ts` checks every page at 390 px and 1440 px, seeded and
  empty, for zero sideways scroll. Screenshots go to `docs/screens/`.

**The gap is mostly presentation, not data.** Two figures are new:
- **runway:** pool balance ÷ the average live daily spend over the last 7 days;
- **spend by agent:** grouped from `cost_events`.

Both are computed in TypeScript or SQL (rule 4).

---

## 2. Design rules (each one has a test)

1. **Every number says what it is.** It carries a real / estimated / assumed / dry run / simulated
   badge. Simulated data shows only when the global switch is on, and the whole page then shows a
   banner (rule 10). Assumed numbers stay labelled assumed (rule 23).
2. **The browser only formats.** Totals, deltas, ROI, runway and ranks come from the API. A test fails
   if a panel component does arithmetic on money fields.
3. **One decisions path.** Every approve, reject, pass or top-up button calls
   `/api/decisions/:id/decide`. No panel gets its own approval list (rule 18). Defaults stay recorded
   as "defaulted" (rule 19).
4. **The holdout stays hidden** in every panel (rule 22).
5. **Keys never appear.** Panels show a key's name, status and expiry, never its value (rule 20).
6. **Panels fail alone.** One panel's error shows inside that panel; the rest of the page still renders.
7. **Everything drills down.** Every tile and chart point links to the page or filtered list behind it.
8. **Phone works.** Every page passes the 390 px and 1440 px test, seeded and empty.

---

## 3. Architecture

### 3.1 Layout as data

- **Contract.** `packages/contracts/src/layout.ts` defines `LayoutSpec` (Zod), roughly
  `page → sections → panels`. Each panel has:
  - `id` and `title`;
  - `component`: one of the kit names in §3.3;
  - `query`: one of the registry names in §3.2;
  - `args`: fixed arguments, such as `{ "group": "playbook" }`;
  - `span`: 1–4 columns;
  - `refresh_s`: 0 means no automatic refresh;
  - `drill`: the route it opens.
- **Config.** `packages/config/src/layouts/home.json`, plus one file per page that uses panels.
  Moving, adding or removing a panel is a config change, not a code change (rule 7).
- **Checked when it loads.** An unknown component, unknown query, duplicate id or bad span is refused,
  and the page falls back to the last good layout built into the app.
- **Later, not in this plan.** Agents could propose a layout change as a new spec through a decision.
  It would be checked like a graph plan is, and you'd approve it.

### 3.2 Panel registry (API)

- **`apps/api/src/panels.ts`.** A map of name → read-only function. Each returns one shape:
  `{ kind, as_of, note?, figures? | series? | rows? | stages? }`.
- **One route.** `GET /api/panels/:name?from&to&playbook&synthetic&compare=1`.
  - It sits behind Access like every `/api/*` route.
  - It's in the 60-second cache, except panels that read spend caps or budgets, which are always live.
- **Built on code that exists.** No new tables. Each panel's source:

| Query | What it returns | Built from |
|---|---|---|
| `kpis` | The figures from `homeFigures`, plus previous-period values when `compare=1` | `homeFigures` called twice |
| `money_by_day` | Live revenue and spend per day, with an optional playbook split | `daily_rollups` |
| `runway` | Pool balance, 7-day average live spend, days left, date to top up | `pool_events` and `daily_rollups` |
| `needs_you` | Open decisions: type, money at stake, recommended and safe default, deadline | `needsYou` |
| `brief` | The latest digest as short lines | `buildDigest` / `digests` |
| `live_runs` | Running and waiting tasks and graph runs: agent, step, cost so far, status | tasks, workflows, `graph_runs` |
| `pipeline` | Counts per stage: ideas → approved → executing → first revenue → profitable | idea cards, decisions, `daily_rollups` |
| `playbook_board` | Per playbook: revenue, spend, ROI, autonomy, killed, cap used | `daily_rollups`, `playbookStats`, controls, budgets |
| `spend_split` | Spend today and over the period, by agent or playbook, against caps | `cost_events`, `/api/budgets` logic |
| `health` | Kill switch, heartbeat ages, dead letters, uncertain effects, keys failing or expiring, alerts | `/api/runtime`, keys, alerts |

- **Guards.** Every result passes one shared filter (`toPanelResult`). It:
  - drops holdout rows;
  - drops simulated rows unless asked for;
  - refuses any field named like a secret;
  - rounds money to pennies.

### 3.3 Component kit (dashboard)

- **Folder.** `apps/dashboard/src/kit/`, one file each:

| Component | What it draws |
|---|---|
| `Panel` | The frame every panel sits in: title, refreshed-at time, a placeholder while loading, an error with a retry button, an empty state that says what fills it, a drill link |
| `Kpi` | Value, change vs the previous period (▲/▼, coloured by whether up is good), kind badge, 14-day sparkline, 95% range band when present |
| `TrendChart` | Revenue bars against a spend line per day, with a hover readout |
| `Funnel` | Stage bars with counts and the conversion rate between stages |
| `Leaderboard` | A ranked table with an inline bar, one row per playbook |
| `SegmentedBar` | Shares of a total, such as spend by agent, with the cap marked |
| `Heatmap` | A grid of industry × opportunity score, for the Board |
| `SmallMultiples` | One mini chart per playbook, all on the same scale |
| `StatusList` | Rows with a status dot, label, detail and cost, for live runs |
| `HealthStrip` | One line of status chips |
| `DecisionCard` | A Needs-you item: title, money at stake, economics, recommended option, buttons, agent reasoning collapsed underneath |
| `FilterBar` | Period presets (7 / 30 / 90 days / custom), playbook chips, compare toggle, live/simulated switch. The choice lives in the URL hash so it's shareable and survives a reload |

- **Charts: Recharts** (one dependency; OpenUI's own library uses it). The alternative is hand-written
  SVG with no dependency but slower to build. See decision 1.
- **Styles.**
  - CSS variables added to `styles.css`: one colour each for revenue, spend, warning, danger, success,
    plus the kind badges.
  - Numbers use tabular figures so columns line up.
  - Light theme stays the default. Dark mode is decision 3.

### 3.4 Panel loading

- **A hook, `usePanel(query, args, filters)`:** each panel fetches on its own, shows its placeholder,
  retries on demand, and refreshes on its `refresh_s` while the tab is visible.
- **Changing a filter** reloads only the panels that use it.

---

## 4. Pages

### Home (the cockpit), top to bottom

1. **Filter bar** and the live / simulated badge.
2. **Brief.** One line: "While you were away: runs, replies, first revenue, items waiting, spend vs
   budget." Built from the digest.
3. **KPI row.** Revenue, live spend, margin, runway, live agents.
   - A second row: monthly recurring revenue, pipeline value, reply rate, cost to acquire a customer,
     cost to serve.
4. **Needs you** as decision cards, highest money at stake first. A count of zero says "Nothing needs
   you."
5. **Revenue vs spend** by day, plus small multiples per playbook underneath.
6. **Live runs** next to **Pipeline funnel**.
7. **Playbook leaderboard** next to **Spend split**, with caps marked.
8. **Health strip.**

The old collapsed sections ("Data and today", "Quality, lift and unit economics") move to a **Quality**
tab on Home. Nothing is lost.

### Other pages (Phase U3)

| Page | Change |
|---|---|
| **Ideas** | A board with columns for new → approved → executing → earning → killed. Each card shows cost to serve, cost to acquire, expected revenue, confidence and the status of its plan. Pass, fail and ask go through decisions. |
| **Board** | A heatmap of industry × opportunity score. Cell colour is score; a number shows agent spend there. Pin and kill stay where they are. |
| **CRM** | A pipeline board (stage columns, value per stage) with a toggle to today's table. Export stays. |
| **Inbox** | A strip at the top: sent, replies and positive-reply rate per campaign and playbook. |
| **Controls** | A gauge per playbook (spent today against its cap), autonomy level shown as L0–L3 steps, kill switches unchanged. |
| **Vault** | A "learned this week" feed at the top. The knowledge-graph view waits (see "Later"). |

---

## 5. Phases and gates

**U1: foundations.** The contract, the registry, the kit, and no page changes yet.
- The `LayoutSpec` contract and validator, with tests for each refusal.
- `/api/panels/:name` with the 10 queries and the `toPanelResult` guards.
- The kit, the `usePanel` hook, and Recharts.
- A hidden `#/kit` page renders every component on seeded and empty data.
- **Gate:** `pnpm check` green; the new tests (listed in §6) pass; screenshots of `#/kit` at 390 and
  1440 px go to `docs/screens/`; report at `docs/gates/cockpit-u1.md`. **Stop.**

**U2: the Home cockpit.**
- Home is built from `home.json`.
- Quality tab.
- Filters stored in the URL.
- **Gate:**
  - the mobile layout test passes on Home, seeded and empty;
  - one panel's query forced to fail leaves every other panel rendered;
  - before/after screenshots of Home;
  - report `docs/gates/cockpit-u2.md`.
  - **Stop.**

**U3: other pages.**
- Ideas, Board, CRM, Inbox, Controls and Vault as in §4.
- **Gate:** mobile test on every page, screenshots, report `docs/gates/cockpit-u3.md`. **Stop.**

**Later, not in this plan:**
- the Vault knowledge-graph view;
- agent-proposed layout changes through decisions;
- dark mode (unless you choose it in decision 3);
- a mini in-app chart editor.

Deploying stays with the GitHub Deploy workflow. Cloud sessions never deploy.

---

## 6. Tests added

- `LayoutSpec` refuses an unknown component, an unknown query, duplicate ids and a bad span. A broken
  `home.json` falls back to the built-in layout.
- Every query in the registry:
  - returns the shared shape;
  - excludes holdout rows (seeded holdout company never appears);
  - excludes simulated rows unless `synthetic=1`, and labels them when included;
  - never returns a field whose name or value looks like a key (seeded fake key value never appears).
- `runway` matches a hand-worked example: top-ups minus live spend, divided by the 7-day average.
  Dry-run and simulated spend are ignored.
- `kpis` with `compare=1` returns previous-period values over a window of the same length.
- Budget and cap panels are never served from the KV cache. Others are.
- Every `/api/panels/*` request without Access is refused (existing fail-closed test extended).
- Static test: no file in `apps/dashboard/src/kit/` or `panels/` adds, subtracts, multiplies or divides
  money fields. Formatting helpers only.
- Static test: no dashboard file posts approvals anywhere except `/api/decisions/:id/decide`.
- Mobile layout test extended to `#/kit` (U1), Home (U2) and every page (U3).

---

## 7. Risks

- **Bundle size.** Recharts adds roughly 100 KB gzipped. Mitigation: import only the chart types used;
  report the built size at the U1 gate.
- **60-second staleness** on cached panels. Money caps and budgets are never cached, so nothing that
  controls spend is stale.
- **Runway is only as good as `pool_events`.** If top-ups aren't recorded, runway shows "–" with a note
  ("record a top-up in Controls"), never a guess.
- **Live data is thin until cutover.** Many panels will show empty states or dry-run figures at first.
  The empty states say what will fill them.

---

## 8. Decisions for you (my recommendation first)

1. **Charts.** **Recharts (recommended)**: boring, widely used, fast to build. The alternative is
   hand-written SVG, with no dependency but more code to keep up.
2. **Runway.** **Pool balance ÷ 7-day average live spend (recommended).** The alternative is a fixed
   monthly budget in config.
3. **Dark mode.** **Later (recommended).** The alternative is building it into the kit in U1, which
   adds roughly 10% to U1.
4. **Default Home view.** **Last 30 days, live data only, compare on (recommended).**
5. **How to proceed.** Approve **U1** now; U2 and U3 wait for their gates as usual.
