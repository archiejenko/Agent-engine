import type { PanelRow } from "@ae/contracts";
import { fmtRatio, KindBadge, money } from "./format.tsx";

const COLOURS = 6;

/**
 * Shares of a total (e.g. spend by playbook or agent). Segment widths are the API's `share`, used as
 * flex weights; the cap marker sits at the API's `cap_used` along a today-vs-cap bar.
 */
export function SegmentedBar({
  rows,
  total,
  capUsed,
  capGbp,
  spentToday,
}: {
  rows: PanelRow[];
  total: number | null;
  capUsed?: number | null;
  capGbp?: number | null;
  spentToday?: number | null;
}) {
  return (
    <div className="segbar">
      <div className="segbar-track" role="img" aria-label="Spend split">
        {rows.map((r, i) => (
          <span
            key={r.key}
            className={`seg seg-${i % COLOURS}`}
            style={{ flexGrow: r.share as number }}
            title={`${r.label}: ${money(r.spend_gbp as number)}`}
          />
        ))}
      </div>
      <ul className="segbar-legend">
        {rows.map((r, i) => (
          <li key={r.key}>
            <span className={`swatch seg-${i % COLOURS}`} />
            <span className="segbar-name">{r.label}</span>
            <span className="num">
              {money(r.spend_gbp as number)} · {fmtRatio(r.share as number)}
            </span>
            <KindBadge kind={r.kind} />
            {r.cap_today_gbp !== undefined && (
              <small className="muted num">
                today {money(r.spent_today_gbp as number)} of {money(r.cap_today_gbp as number)} cap
              </small>
            )}
          </li>
        ))}
      </ul>
      <p className="muted num">Total {money(total)}</p>
      {capGbp !== undefined && capGbp !== null && (
        <div className="cap">
          <div className="cap-track">
            <div
              className="cap-fill"
              style={{ transform: `scaleX(${Math.min(1, capUsed ?? 0)})` }}
            />
          </div>
          <small className="muted num">
            Today {money(spentToday ?? null)} of {money(capGbp)} daily cap ({fmtRatio(capUsed)})
          </small>
        </div>
      )}
    </div>
  );
}
