import { KindBadge, money } from "./format.tsx";

export interface HeatCell {
  row: string;
  col: string;
  /** 0–1 colour strength, computed by the API (e.g. opportunity score). */
  intensity: number;
  /** The number printed in the cell (e.g. agent spend there). */
  spend_gbp: number | null;
  /** Hover: expected monthly profit per £1 of agent spend, and per hour of Archie's time (API). */
  monthly_profit_per_gbp_spend?: number | null;
  profit_per_hour_gbp?: number | null;
  drill?: string | null;
}

/** Hover text: the cell's figures as the API computed them (formatting only). */
function hoverOf(row: string, col: string, cell: HeatCell | undefined): string {
  if (!cell) return `${row}, ${col}: no market yet`;
  const per = cell.monthly_profit_per_gbp_spend;
  const hour = cell.profit_per_hour_gbp;
  return [
    `${row}, ${col}`,
    per === null || per === undefined
      ? "no idea card yet"
      : `${money(per)} expected monthly profit per £1 of agent spend`,
    hour === null || hour === undefined ? null : `${money(hour)} per hour of your time`,
    `${money(cell.spend_gbp)} spent so far`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A grid of rows × columns (industry × opportunity score band, for the Board in U3). */
export function Heatmap({
  rows,
  cols,
  cells,
  kind = "estimated",
}: {
  rows: string[];
  cols: string[];
  cells: HeatCell[];
  kind?: "real" | "estimated" | "assumed" | "dry_run" | "synthetic";
}) {
  const at = (r: string, c: string) => cells.find((x) => x.row === r && x.col === c);
  return (
    <div className="heatmap-wrap">
      <table className="heatmap">
        <thead>
          <tr>
            <th />
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r}>
              <th scope="row">{r}</th>
              {cols.map((c) => {
                const cell = at(r, c);
                return (
                  <td
                    key={c}
                    className="heat"
                    style={{ "--i": cell?.intensity ?? 0 } as React.CSSProperties}
                    title={hoverOf(r, c, cell)}
                  >
                    {cell?.drill ? (
                      <a href={`#${cell.drill}`}>{money(cell.spend_gbp, { whole: true })}</a>
                    ) : cell ? (
                      money(cell.spend_gbp, { whole: true })
                    ) : (
                      ""
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Colour: expected monthly profit per £1 of agent spend (darker is better). Number: agent
        spend there so far. Hover a cell for profit per hour of your time. <KindBadge kind={kind} />
      </p>
    </div>
  );
}
