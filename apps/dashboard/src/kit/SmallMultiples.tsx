import type { PanelPoint, PanelRow } from "@ae/contracts";
import { KindBadge, money } from "./format.tsx";
import { TrendChart } from "./TrendChart.tsx";

/** One mini revenue-vs-spend chart per playbook, all on the same scale (set by the API). */
export function SmallMultiples({ rows, scaleMax }: { rows: PanelRow[]; scaleMax: number | null }) {
  return (
    <div className="multiples">
      {rows.map((r) => (
        <figure key={r.key} className="multiple">
          <figcaption>
            <b>{r.label}</b> <KindBadge kind={r.kind} />
            <span className="muted num">
              {money(r.revenue_gbp as number)} in · {money(r.spend_gbp as number)} out
            </span>
          </figcaption>
          <TrendChart series={r.series as PanelPoint[]} height={70} scaleMax={scaleMax} compact />
        </figure>
      ))}
    </div>
  );
}
