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
        {/* "–" is no number, so it carries no kind. */}
        {f.value !== null && <KindBadge kind={f.kind} />}
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

/**
 * A one-column stack (e.g. Runway beside the KPI row): the first figure as a full KPI, the others as
 * compact label–value lines, so the panel stays about as tall as the row next to it.
 */
export function KpiStack({ figures }: { figures: PanelFigure[] }) {
  const [head, ...rest] = figures;
  if (!head) return null;
  return (
    <div className="kpi-stack">
      <Kpi f={head} />
      {rest.length > 0 && (
        <dl className="kpi-lines">
          {rest.map((f) => (
            <div key={f.key} title={f.note ?? undefined}>
              <dt>{f.label}</dt>
              <dd className="num">
                {fmt(f.value, f.unit)} {f.value !== null && <KindBadge kind={f.kind} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
