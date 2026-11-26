import { KindBadge, money } from "./format.tsx";

export interface HeatCell {
  row: string;
  col: string;
  /** 0–1 colour strength, computed by the API (e.g. opportunity score). */
  intensity: number;
  /** The number printed in the cell (e.g. agent spend there). */
  spend_gbp: number | null;
  drill?: string | null;
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
                    title={`${r}, ${c}`}
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
        Colour: score. Number: agent spend there. <KindBadge kind={kind} />
      </p>
    </div>
  );
}
