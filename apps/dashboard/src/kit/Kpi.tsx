import type { PanelFigure } from "@ae/contracts";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { fmt, fmtChange, fmtSignedRatio, KindBadge } from "./format.tsx";

/**
 * One headline number: value, change vs the previous period (▲/▼, green when the move is good news),
 * its kind badge, a 14-day sparkline and the 95% range when measured. Everything shown is computed by
 * the API; this only formats it.
 */
export function Kpi({ f }: { f: PanelFigure }) {
  const hasChange = f.change !== undefined && f.change !== null;
  const up = hasChange && (f.change as number) > 0;
  const down = hasChange && (f.change as number) < 0;
  const good = (up && f.up_is_good !== false) || (down && f.up_is_good === false);
  const tone = !up && !down ? "flat" : good ? "good" : "bad";
  const spark = f.spark?.map((v, i) => ({ i, v }));
  return (
    <div className="kpi">
      <div className="kpi-label">
        <span>{f.label}</span>
        <KindBadge kind={f.kind} />
      </div>
      <div className="kpi-value num">{fmt(f.value, f.unit)}</div>
      {hasChange && (
        <div className={`kpi-change ${tone}`}>
          <span aria-hidden="true">{up ? "▲" : down ? "▼" : "■"}</span>{" "}
          {fmtChange(f.change as number, f.unit)}
          {f.change_ratio !== undefined && f.change_ratio !== null && (
            <> ({fmtSignedRatio(f.change_ratio)})</>
          )}
          <span className="muted"> vs {fmt(f.previous ?? null, f.unit)}</span>
        </div>
      )}
      {f.ci95 && (
        <div className="kpi-range muted">
          95% range {fmt(f.ci95[0], f.unit)} to {fmt(f.ci95[1], f.unit)}
        </div>
      )}
      {spark && spark.length > 1 && (
        <div className="kpi-spark" aria-hidden="true">
          <ResponsiveContainer width="100%" height={28}>
            <LineChart data={spark} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Line
                type="monotone"
                dataKey="v"
                stroke="var(--c-accent)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {f.note && <div className="kpi-note muted">{f.note}</div>}
    </div>
  );
}

/** A row of KPIs (wraps on a phone). */
export function KpiRow({ figures }: { figures: PanelFigure[] }) {
  return (
    <div className="kpi-row">
      {figures.map((f) => (
        <Kpi key={f.key} f={f} />
      ))}
    </div>
  );
}
