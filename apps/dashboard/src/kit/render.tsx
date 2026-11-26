import type { PanelComponent, PanelResult, PanelRow, PanelSpec } from "@ae/contracts";
import { DecisionList } from "./DecisionCard.tsx";
import { Funnel } from "./Funnel.tsx";
import type { Filters } from "./filters.ts";
import { HealthStrip } from "./HealthStrip.tsx";
import { type HeatCell, Heatmap } from "./Heatmap.tsx";
import { KpiRow } from "./Kpi.tsx";
import { Leaderboard } from "./Leaderboard.tsx";
import { Panel } from "./Panel.tsx";
import { SegmentedBar } from "./SegmentedBar.tsx";
import { SmallMultiples } from "./SmallMultiples.tsx";
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
}: {
  component: PanelComponent;
  result: PanelResult;
  dryRun?: boolean;
  onDecided?: () => void;
}) {
  const rows = result.rows ?? [];
  const meta = result.meta ?? {};
  switch (component) {
    case "Kpi":
      return <KpiRow figures={result.figures ?? []} />;
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
  const args: Record<string, string | number | boolean> = spec.args ?? {};
  const p = usePanel(spec.query, args, filters, spec.refresh_s);
  return (
    <Panel
      title={spec.title}
      span={spec.span}
      drill={spec.drill}
      status={p.status}
      result={p.result}
      error={p.error}
      onRetry={p.retry}
    >
      {(r) => <PanelBody component={spec.component} result={r} onDecided={p.retry} />}
    </Panel>
  );
}
