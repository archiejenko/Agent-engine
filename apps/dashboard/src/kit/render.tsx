import type { PanelComponent, PanelResult, PanelRow, PanelSpec } from "@ae/contracts";
import { useState } from "react";
import { DecisionList } from "./DecisionCard.tsx";
import { Funnel } from "./Funnel.tsx";
import type { Filters } from "./filters.ts";
import { Gauges } from "./Gauges.tsx";
import { HealthStrip } from "./HealthStrip.tsx";
import { type HeatCell, Heatmap } from "./Heatmap.tsx";
import { Kanban } from "./Kanban.tsx";
import { KpiRow, KpiStack } from "./Kpi.tsx";
import { Leaderboard } from "./Leaderboard.tsx";
import { Panel } from "./Panel.tsx";
import { SegmentedBar } from "./SegmentedBar.tsx";
import { SmallMultiples } from "./SmallMultiples.tsx";
import { StatStrip } from "./StatStrip.tsx";
import { StatusList } from "./StatusList.tsx";
import { TrendChart } from "./TrendChart.tsx";
import { usePanel } from "./usePanel.ts";

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** Draws a panel result with the kit component a layout names. */
export function PanelBody({
  component,
  result,
  dryRun,
  onDecided,
  span = 4,
}: {
  component: PanelComponent;
  result: PanelResult;
  /** A one-column Kpi panel stacks: its first figure big, the rest as compact lines. */
  span?: number;
  dryRun?: boolean;
  onDecided?: () => void;
}) {
  const rows = result.rows ?? [];
  const meta = result.meta ?? {};
  switch (component) {
    case "Kpi":
      return span === 1 ? (
        <KpiStack figures={result.figures ?? []} />
      ) : (
        <KpiRow figures={result.figures ?? []} />
      );
    case "TrendChart":
      return <TrendChart series={result.series ?? []} />;
    case "SmallMultiples":
      return <SmallMultiples rows={rows} scaleMax={num(meta.scale_max_gbp)} />;
    case "Funnel":
      return <Funnel stages={result.stages ?? []} />;
    case "Leaderboard":
      return <Leaderboard rows={rows} />;
    case "SegmentedBar":
      return (
        <SegmentedBar
          rows={rows}
          total={num(meta.total_gbp)}
          capUsed={num(meta.global_cap_used)}
          capGbp={num(meta.global_cap_today_gbp)}
          spentToday={num(meta.global_spent_today_gbp)}
        />
      );
    case "StatusList":
      return <StatusList rows={rows} />;
    case "HealthStrip":
      return <HealthStrip rows={rows} />;
    case "DecisionCard":
      return (
        <DecisionList
          rows={rows}
          dryRun={dryRun ?? false}
          {...(onDecided ? { onDone: () => onDecided() } : {})}
        />
      );
    case "Kanban":
      return (
        <Kanban stages={result.stages ?? []} rows={rows} {...(onDecided ? { onDecided } : {})} />
      );
    case "Gauges":
      return <Gauges rows={rows} />;
    case "StatStrip":
      return <StatStrip rows={rows} />;
    case "Heatmap": {
      const cells: HeatCell[] = rows.flatMap((r: PanelRow) =>
        ((r.cells as Omit<HeatCell, "row">[] | undefined) ?? []).map((c) => ({
          ...c,
          row: r.label,
        })),
      );
      return (
        <Heatmap
          rows={rows.map((r) => r.label)}
          cols={[...new Set(cells.map((c) => c.col))]}
          cells={cells}
          kind={result.value_kind ?? "estimated"}
        />
      );
    }
  }
}

/** A panel from a layout spec: fetches its own query and fails on its own. */
export function LivePanel({ spec, filters }: { spec: PanelSpec; filters: Filters }) {
  // The leaderboard lists active playbooks; "Show all (N)" asks the API for every one.
  const [showAll, setShowAll] = useState(false);
  const args: Record<string, string | number | boolean> = {
    ...(spec.args ?? {}),
    ...(showAll ? { all: 1 } : {}),
  };
  const p = usePanel(spec.query, args, filters, spec.refresh_s);
  // Totals come from the API: needs_you counts open decisions, live_runs counts runs.
  const meta = p.result?.meta ?? {};
  const total = num(meta.total_open) ?? (spec.query === "live_runs" ? num(meta.total) : null);
  const shown = num(meta.shown);
  const more = total !== null && shown !== null && total > shown && spec.drill;
  const active = num(meta.active);
  const allCount = num(meta.total);
  const toggle =
    // No toggle when the layout already asks for every playbook (Controls' gauges).
    !spec.args?.all && active !== null && allCount !== null && (showAll || allCount > active) ? (
      <button type="button" className="panel-toggle" onClick={() => setShowAll(!showAll)}>
        {showAll ? `Active only (${active})` : `Show all (${allCount})`}
      </button>
    ) : null;
  return (
    <Panel
      title={spec.title}
      span={spec.span}
      drill={spec.drill}
      status={p.status}
      result={p.result}
      error={p.error}
      onRetry={p.retry}
      count={num(meta.total_open)}
      seeAll={more && spec.drill ? { href: spec.drill, total } : null}
      action={toggle}
    >
      {(r) => (
        <PanelBody component={spec.component} result={r} onDecided={p.retry} span={spec.span} />
      )}
    </Panel>
  );
}
