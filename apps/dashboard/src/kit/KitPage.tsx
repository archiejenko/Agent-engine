import type { PanelComponent, PanelSpec } from "@ae/contracts";
import { useState } from "react";
import { FilterBar } from "./FilterBar.tsx";
import { useFilters } from "./filters.ts";
import { EMPTY, SAMPLE } from "./fixtures.ts";
import { Panel } from "./Panel.tsx";
import { LivePanel, PanelBody } from "./render.tsx";

/** Every registry query, live, drawn by the component Home will use for it (cockpit U1 preview). */
const LIVE: PanelSpec[] = [
  {
    id: "brief",
    title: "Brief",
    component: "StatusList",
    query: "brief",
    args: {},
    span: 4,
    refresh_s: 0,
    drill: "/",
  },
  {
    id: "kpis",
    title: "KPIs",
    component: "Kpi",
    query: "kpis",
    args: { set: "primary" },
    span: 3,
    refresh_s: 0,
    drill: "/",
  },
  {
    id: "runway",
    title: "Runway",
    component: "Kpi",
    query: "runway",
    args: {},
    span: 1,
    refresh_s: 0,
    drill: "/controls",
  },
  {
    id: "needs_you",
    title: "Needs you",
    component: "DecisionCard",
    query: "needs_you",
    args: {},
    span: 4,
    refresh_s: 0,
    drill: "/",
  },
  {
    id: "money",
    title: "Revenue vs spend",
    component: "TrendChart",
    query: "money_by_day",
    args: {},
    span: 4,
    refresh_s: 0,
    drill: "/controls",
  },
  {
    id: "multiples",
    title: "By playbook",
    component: "SmallMultiples",
    query: "money_by_day",
    args: { split: "playbook" },
    span: 4,
    refresh_s: 0,
    drill: "/controls",
  },
  {
    id: "live_runs",
    title: "Live runs",
    component: "StatusList",
    query: "live_runs",
    args: {},
    span: 2,
    refresh_s: 30,
    drill: "/controls",
  },
  {
    id: "pipeline",
    title: "Pipeline",
    component: "Funnel",
    query: "pipeline",
    args: {},
    span: 2,
    refresh_s: 0,
    drill: "/ideas",
  },
  {
    id: "board",
    title: "Playbook leaderboard",
    component: "Leaderboard",
    query: "playbook_board",
    args: {},
    span: 2,
    refresh_s: 0,
    drill: "/controls",
  },
  {
    id: "split",
    title: "Spend split",
    component: "SegmentedBar",
    query: "spend_split",
    args: { group: "playbook" },
    span: 2,
    refresh_s: 0,
    drill: "/controls",
  },
  {
    id: "health",
    title: "Health",
    component: "HealthStrip",
    query: "health",
    args: {},
    span: 4,
    refresh_s: 0,
    drill: "/controls",
  },
];

const ORDER: PanelComponent[] = [
  "Kpi",
  "TrendChart",
  "SmallMultiples",
  "Leaderboard",
  "Funnel",
  "SegmentedBar",
  "Heatmap",
  "StatusList",
  "HealthStrip",
  "DecisionCard",
  "Kanban",
  "Gauges",
  "StatStrip",
];
const WIDE = new Set<PanelComponent>([
  "Kanban",
  "Gauges",
  "StatStrip",
  "Kpi",
  "TrendChart",
  "SmallMultiples",
  "HealthStrip",
  "DecisionCard",
  "Leaderboard",
]);

/**
 * Hidden page (#/kit, not in the navigation): every kit component on sample data and on empty data,
 * the loading and error states, and every panel query live from the API. Buttons here never post.
 */
export function KitPage() {
  const [filters, setFilters] = useFilters();
  const [failed, setFailed] = useState(0);
  return (
    <div className="kit">
      <h2>Component kit</h2>
      <p className="muted">
        A hidden page for checking the cockpit's building blocks. Sample numbers are illustrative;
        the live section reads the real panel queries.
      </p>
      <FilterBar
        value={filters}
        onChange={setFilters}
        playbooks={["sme_outreach", "sme_letter", "claim_site"]}
      />

      <h3>Sample data</h3>
      <div className="panel-grid">
        {ORDER.map((c) => (
          <Panel
            key={c}
            title={c}
            span={WIDE.has(c) ? 4 : 2}
            drill={null}
            status="ok"
            result={SAMPLE[c]}
          >
            {(r) => <PanelBody component={c} result={r} dryRun />}
          </Panel>
        ))}
      </div>

      <h3>Empty data</h3>
      <div className="panel-grid">
        {ORDER.map((c) => (
          <Panel key={c} title={c} span={2} drill={null} status="ok" result={EMPTY[c]}>
            {(r) => <PanelBody component={c} result={r} dryRun />}
          </Panel>
        ))}
      </div>

      <h3>Placeholder and error states</h3>
      <div className="panel-grid">
        <section className="panel span-2" aria-label="Placeholder example">
          <header className="panel-head">
            <h3>Still fetching (placeholder)</h3>
          </header>
          <div className="panel-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </section>
        <Panel
          title="Error example"
          span={2}
          status="error"
          result={null}
          error={`HTTP 500 (retried ${failed} time(s))`}
          onRetry={() => setFailed((n) => n + 1)}
        >
          {() => null}
        </Panel>
      </div>

      <h3>Live panels</h3>
      <div className="panel-grid">
        {LIVE.map((p) => (
          <LivePanel key={p.id} spec={p} filters={filters} />
        ))}
      </div>
    </div>
  );
}
