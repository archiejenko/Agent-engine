---
type: build-report
milestone: cockpit-U1
date: 2026-11-26
status: STOPPED — waiting for Archie
---

# Cockpit UI U1: foundations — stop-point report

U1 is built: the layout contract, the panel registry, the chart kit and a hidden page that shows every
piece. **No page you use has changed** (Home, the other pages and the navigation are untouched). Gate
evidence: `docs/gates/cockpit-u1.md`. **I've stopped here.** U2 (the Home cockpit) waits for your go-ahead.

## 1. What was built

**Layout as data.** `packages/contracts/src/layout.ts` defines a page as sections of panels. Each panel
names a kit component, a panel query, fixed arguments, a width (1–4 columns), a refresh time and the page
it opens. Home's layout is `packages/config/src/layouts/home.json`, in the order from the plan: brief →
KPIs → Needs you → money → agent activity → health. A broken file (unknown component or query, repeated
id, bad width, misspelt field) is refused, and the page gets a small built-in layout instead: money,
Needs you, health.

**Ten panel queries** at `GET /api/panels/:name` (`apps/api/src/panels.ts`), behind Access like every
`/api/*` route, built on existing functions and tables only (no new tables, no migrations):

| Panel | What it gives |
|---|---|
| `kpis` | Revenue, live spend, margin, live agents; second row MRR, pipeline, reply rate, cost to acquire, cost to serve. With compare on: last period's value and the change |
| `money_by_day` | Live revenue and spend per day, or one series per playbook on a shared scale |
| `runway` | Agent pool, 7-day average live spend, days left, date to top up |
| `needs_you` | Open decisions, highest money at stake first |
| `brief` | Yesterday's digest as four short lines |
| `live_runs` | Running and waiting tasks, graph runs and workflows |
| `pipeline` | Ideas → approved → executing → first revenue → profitable |
| `playbook_board` | Per playbook: net, revenue, spend, ROI, autonomy, killed, today's cap used |
| `spend_split` | Live spend by playbook or by agent, with today's spend against the caps |
| `health` | Kill switch, queue, heartbeats, failed jobs, uncertain actions, failing keys, alerts |

Every answer passes one guard, `toPanelResult`. It:
- drops any row naming a holdout company and strips arm/cohort fields (rule 22);
- drops simulated rows unless you ask for them, and labels them "simulated" when you do (rule 10);
- refuses a field named like a secret or a value shaped like a key (rule 20);
- rounds money to pennies.

"Live" money always means real mode, not simulated and not dry run.

**The kit** (`apps/dashboard/src/kit/`): Panel, Kpi, TrendChart, Funnel, Leaderboard, SegmentedBar,
Heatmap, SmallMultiples, StatusList, HealthStrip, DecisionCard and FilterBar.
- Every number carries a badge: real, estimated, assumed, dry run or simulated.
- Components only format. Totals, changes, shares, ranks and bar lengths all come from the API.
- Decision buttons post only to `/api/decisions/:id/decide`. Items you need to read first (drafts,
  print batches, plans, site publishing) link to the full item instead.
- The filter bar keeps its choice in the address (for example `#/kit?period=7&compare=0`), so a view
  survives a reload and can be shared. Default: last 30 days, live only, compare on.
- Colours are CSS variables, so a dark theme only has to redefine them later.

**`usePanel`** loads each panel on its own. It shows a placeholder while loading, an error with a Retry
button, and an empty state that says what will fill it. It refreshes on the panel's timer while the tab
is visible. One panel failing doesn't touch the others.

**`#/kit`** (hidden, not in the navigation) shows:
- every component on sample data and on empty data;
- the placeholder and error states;
- all ten queries live from the API.

## 2. Tests

- `pnpm check` green: **573 tests in 86 files** (542 before; 31 new, 1 extended).
- New: layout refusals and fallback (8); panel shape, holdout, simulated rows, fake key, runway worked
  example, compare window, caching, guard (16); Access refusal on every panel (1); static checks for
  money arithmetic and approval routes (6).
- The phone layout test now covers `#/kit` at 390 and 1440 px, seeded and empty: zero sideways scroll.
- Screenshots: `docs/screens/dashboard-kit-*.png`.

## 3. Bundle size

| | Before | After |
|---|---|---|
| Main JS (gzipped) | 91.05 KB | 92.27 KB |
| Kit + Recharts chunk (gzipped) | – | 118.80 KB, loaded only on pages that use the kit |

Recharts alone is about 115 KB gzipped, a little over the plan's ~100 KB estimate. Loading it as its own
chunk keeps every page that has no charts as fast as before.

## 4. Deviations from the plan, and why

1. **Two more panels are never cached:** `health` and `needs_you`, as well as the cap and pool panels.
   - `health`: a kill switch you just flipped must show at once.
   - `needs_you`: a 60-second-old queue would show a decision again after you made it.
2. **A few extra fields in the API**, so the browser never calculates:
   - `days` (the 7/30/90 presets);
   - `share` per funnel stage, and `bar_share` and `rank` on the leaderboard;
   - a shared scale for the small multiples;
   - one `value_kind` badge per chart or list.
3. **The brief uses `StatusList`.** The plan's kit has no "brief" component, so I didn't add a 13th.
4. **The pipeline mixes two units.** Ideas are counted as idea cards; first revenue and profitable are
   counted as revenue paths, because revenue isn't recorded per idea. So there's no conversion rate
   between those two parts.
5. **The approvals static test has a list of four older routes.** Budgets (raise a tier), Controls
   (promote), Board (pin/kill) and Letters (print batch) post approvals to their own routes, not to
   `/api/decisions/:id/decide`.
   - Each of those routes already records through the decisions path on the server, and the test checks
     that.
   - The test fails on any new route.
   - Changing those pages is outside U1, so they stay as they are for now.
6. **The `#/kit` live section uses a fixed list of panels in code**, not `home.json`. How Home reads its
   layout is a U2 question (below).

All the choices above are also logged in `docs/decisions.md` (26 Nov, "Cockpit U1").

## 5. What you need to decide before U2

1. **Holdout drafts on Home (important).** As instructed, `needs_you` drops any decision about a holdout
   company.
   - If Home's Needs-you becomes this panel in U2, holdout drafts would never reach you there. They would
     time out to the safe default (don't send).
   - That would quietly starve the holdout arm and bias the ranked-vs-holdout lift.
   - **My recommendation:** `needs_you` keeps those items but shows them blind (no arm label), the way
     today's queue does. Rule 22 hides the *assignment*, not the company. The alternative is to keep a
     link to the full queue on Home.
2. **Needs-you length.** The seeded world has 35 open items, and 20 full cards make a very long panel.
   - **My recommendation:** show the top 5 by money at stake, then "see all 35".
3. **Uncached `health` and `needs_you`.** Is that OK? (Recommended.)
4. **How Home reads `home.json`.**
   - **My recommendation:** a new `GET /api/layouts/home` that returns the checked layout, so the
     checking code (Zod) stays out of the browser bundle.
   - The alternative is to check it in the browser, which adds about 15 KB.
5. **Charts on Home will load the 119 KB chart chunk.** Accept it, or load the chart panels only once
   they scroll into view? (I recommend accepting it: it's a one-off download, cached afterwards.)
6. **The four older approval routes.** Move their buttons onto `/api/decisions/:id/decide` in U3
   (recommended), or leave them as they are?

## 6. Also noticed (not changed)

- In the Phase 5 simulator world, "SYNTHETIC TRADING …" lead decisions are stored with `synthetic = 0`,
  so they show with the simulated switch off. That's how the gate seeds them, not the cockpit. They'll
  disappear once real data replaces the simulator.
- The deploy check that says the dashboard is "not behind Access" is your Cloudflare dashboard setting,
  as you said. I haven't touched it.
