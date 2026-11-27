import type { PanelPoint } from "@ae/contracts";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { dayLabel, money } from "./format.tsx";

/** Revenue bars against a spend line, per day, with a hover readout. Values come from the API. */
export function TrendChart({
  series,
  height = 220,
  scaleMax,
  compact = false,
}: {
  series: PanelPoint[];
  height?: number;
  /** A shared top of the y-axis (small multiples), computed by the API. */
  scaleMax?: number | null;
  compact?: boolean;
}) {
  return (
    <div className="chart" role="img" aria-label="Revenue and spend by day">
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart
          data={series}
          margin={{ top: 6, right: 4, bottom: 0, left: compact ? 0 : 4 }}
        >
          {!compact && <CartesianGrid stroke="var(--c-grid)" vertical={false} />}
          <XAxis
            dataKey="day"
            tickFormatter={dayLabel}
            tick={{ fontSize: 11 }}
            minTickGap={24}
            hide={compact}
          />
          <YAxis
            width={compact ? 0 : 52}
            hide={compact}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => money(v, { whole: true })}
            domain={scaleMax ? [0, scaleMax] : [0, "auto"]}
            allowDecimals={false}
            allowDataOverflow={false}
          />
          <Tooltip
            formatter={(v, name) => [
              money(Number(v)),
              name === "revenue_gbp" ? "Revenue" : "Spend",
            ]}
            labelFormatter={(d) => dayLabel(String(d))}
          />
          <Bar
            dataKey="revenue_gbp"
            name="revenue_gbp"
            fill="var(--c-revenue)"
            isAnimationActive={false}
          />
          <Line
            dataKey="spend_gbp"
            name="spend_gbp"
            stroke="var(--c-spend)"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      {!compact && (
        <p className="chart-legend">
          <span className="swatch revenue" /> Revenue <span className="swatch spend" /> Spend
        </p>
      )}
    </div>
  );
}
