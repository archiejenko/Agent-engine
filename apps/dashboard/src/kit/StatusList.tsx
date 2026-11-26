import type { PanelRow } from "@ae/contracts";
import { KindBadge, money, when } from "./format.tsx";

/** Rows with a status dot, label, detail and cost (live runs, the brief). */
export function StatusList({ rows }: { rows: PanelRow[] }) {
  return (
    <ul className="status-list">
      {rows.map((r) => {
        const cost = r.cost_gbp as number | null | undefined;
        return (
          <li key={r.key}>
            <span
              className={`dot ${r.status ?? "info"}`}
              role="img"
              aria-label={r.status ?? "info"}
            />
            <span className="status-main">
              {r.drill ? <a href={`#${r.drill}`}>{r.label}</a> : r.label}
              {r.detail && <small className="muted"> · {r.detail}</small>}
              {typeof r.started_at === "string" && (
                <small className="muted"> · since {when(r.started_at)}</small>
              )}
            </span>
            {cost !== undefined && cost !== null && (
              <span className="num status-cost">
                {money(cost)} <KindBadge kind={r.kind} />
              </span>
            )}
            {(cost === undefined || cost === null) && r.kind === "synthetic" && (
              <KindBadge kind="synthetic" />
            )}
          </li>
        );
      })}
    </ul>
  );
}
