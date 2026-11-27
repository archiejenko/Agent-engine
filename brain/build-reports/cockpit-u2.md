---
type: build-report
milestone: cockpit-U2
date: 2026-11-27
status: STOPPED — waiting for Archie
---

# Cockpit UI U2: the Home cockpit — stop-point report

Home is now the cockpit, built from `home.json`. The fixes from the U1 screenshots and your answers at the
U1 gate are in, each with a test. Gate evidence: `docs/gates/cockpit-u2.md`. **I've stopped here.** U3
(the other pages) waits for your go-ahead.

## 1. What changed on Home

Home has three tabs (each has its own address, so links and reloads land on the right one):

- **Cockpit** (the default), top to bottom:
  - the filter bar and a "Live data only" / "Live + simulated data" badge;
  - the brief;
  - Money (revenue, live spend, margin, live agents) beside Runway;
  - Growth and unit economics;
  - Needs you;
  - revenue vs spend by day, and one small chart per playbook;
  - live runs beside the pipeline funnel;
  - the playbook leaderboard, then spend split;
  - health.
- **Needs you (all):** the full decisions queue, exactly as before. The cockpit's "See all (N)" opens it.
- **Quality:** every figure the old Home tiles showed (sends, sales, lift and review minutes included),
  the daily digest, "Data and today" and "Quality, lift and unit economics". Nothing was removed.

The filters are kept in the address. The default is the last 30 days, live data only, compare on.

Every panel loads, refreshes and fails on its own. A test forces the KPI query to fail: the two KPI
panels show the error with a Retry button, every other panel renders, and Retry brings them back.

## 2. Fixes from the U1 screenshots

| Fix | What I did | Test |
|---|---|---|
| Needs you showed simulated leads with simulated off | A decision now counts as simulated if its own flag says so, if its task is simulated, or if its company was only ever in simulated cohorts. Simulated items are hidden by default and labelled when included. **Partly done:** see question 1 | `panels.test.ts` |
| Compare periods seemed to share a day | The windows were already back to back ([from, to)), but the numbers behind margin, cost to acquire and cost to serve had no end date. So "last period" also counted this period's tasks. That's fixed (`unitEconomics` takes an end date). The note now names both windows | boundary test (events at the exact midnight) + `economics-window.test.ts` |
| Funnel halves count different things | A dashed divider where ideas end and revenue paths begin, with the note "The two halves count different things" | `kit.test.ts` |
| "–" had a kind badge | No badge without a number (KPIs, the Runway lines and empty panels) | `kit.test.ts` |
| Gaps beside KPIs and Runway | Panels in a row share one height. Runway shows one big figure and two compact lines, so it matches the KPI row. The leaderboard and spend split are full width, and live runs is capped at 6 rows so it sits level with the funnel | before/after screenshots |

## 3. Your U1 answers, as built

1. **Holdout: blind, not drop.** Rows stay, and fields named arm, cohort or holdout are stripped at any
   depth. A test shows that a holdout company's draft is in Needs you with exactly the same fields as a
   ranked company's.
2. **Needs you on Home:** the top 5 by money at stake, the open count beside the title, and "See all (N)".
   The brief's "N waiting" uses the same count, so the two always agree.
3. **Health and Needs you are never cached.**
4. **`home.json` is checked when the dashboard builds.**
   - A Vite plugin runs the full check before every build and dev start, so a bad file fails the build.
     I tried it by hand: the build stopped and named the bad field.
   - The dashboard imports the file directly, with only a light check in the browser, so Zod isn't in
     the bundle.
   - The built-in layout is still the fallback.
5. **The chart chunk starts downloading when Home opens.**
6. **The four older approval buttons are left for U3.**

## 4. Tests and size

- `pnpm check` green: **590 tests in 89 files** (17 more than U1).
- The phone layout test covers Home and both new tabs at 390 and 1440 px, seeded and empty: zero
  sideways scroll.
- New browser tests check that a failing panel stays on its own, that Needs you shows the top 5 and its
  button posts only to `/api/decisions/:id/decide`, and that "See all" opens the full queue.
- Bundle (gzipped):
  - main 92.30 KB (U1: 92.27);
  - charts and kit 116.32 KB (U1: 118.80), now one shared chunk;
  - the cockpit itself 1.65 KB.
- Screenshots: `docs/screens/dashboard-home-before-*` and `dashboard-home-after-*` (390 and 1440,
  seeded and empty).

## 5. Deviations from the plan

- **The leaderboard and spend split are stacked**, not side by side: the leaderboard's eight columns
  don't fit in half a row. You allowed restacking for the gaps.
- **Home has a "Needs you (all)" tab** as the target of "See all". The old full queue had no other home
  once the cockpit replaced it.
- **One extra shared change:** `unitEconomics` now accepts an end date. Without it, the compare
  periods overlapped. `/api/home` and the Quality tab get the same, more accurate, windows.

## 6. Questions for you before U3

1. **The simulator's "SYNTHETIC TRADING" leads.** Nothing in the database marks them as simulated.
   - The gate world loads fake Companies House files through the normal pipeline, so the companies,
     facts, opportunities and decisions all look real, and there's no task or cohort behind those leads.
   - My fix catches every case that has a task or cohort; these leads have neither.
   - I won't guess from the company name.
   - **Options:**
     - (a) **(Recommended)** add a `synthetic` column to opportunities, set when the scoring run's facts
       came from a simulated load. That needs a migration, so I'm asking first.
     - (b) mark the gate world's leads as simulated in the gate seed only.
     - (c) leave it: it only affects the test world, never real data.
2. **The leaderboard on a phone** is a scrolling table inside its panel. Do you want a compact card per
   playbook on phones in U3 instead?
3. **Runway shows "–" until you record a top-up in Controls.** Would you like a one-click "record a
   top-up" decision card in U3? It would go through the decisions path.
