import type { PanelRow } from "@ae/contracts";
import { fmtRatio, KindBadge, money } from "./format.tsx";

/** Ranked playbooks with an inline bar (length from the API's bar_share), autonomy and cap use. */
export function Leaderboard({ rows }: { rows: PanelRow[] }) {
  return (
    <div className="table-scroll">
      <table className="leaderboard">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Playbook</th>
            <th className="num">Net</th>
            <th className="num">Revenue</th>
            <th className="num">Spend</th>
            <th className="num">ROI</th>
            <th>Autonomy</th>
            <th className="num">Cap used today</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.killed ? "killed" : undefined}>
              <td className="num">{r.rank as number}</td>
              <td>
                {r.drill ? <a href={`#${r.drill}`}>{r.label}</a> : r.label}{" "}
                {r.killed ? <span className="pill off">killed</span> : null}
                <div className="lb-track">
                  <div
                    className={`lb-bar ${(r.net_gbp as number) < 0 ? "neg" : ""}`}
                    style={{ transform: `scaleX(${(r.bar_share as number) ?? 0})` }}
                  />
                </div>
              </td>
              <td className="num">
                {money(r.net_gbp as number)} <KindBadge kind={r.kind} />
              </td>
              <td className="num">{money(r.revenue_gbp as number)}</td>
              <td className="num">{money(r.spend_gbp as number)}</td>
              <td className="num">{fmtRatio(r.roi as number | null)}</td>
              <td>{(r.autonomy as string) ?? "–"}</td>
              <td className="num">
                {r.cap_today_gbp !== undefined ? (
                  <>
                    {fmtRatio(r.cap_used as number | null)}{" "}
                    <small className="muted">of {money(r.cap_today_gbp as number)}</small>
                  </>
                ) : (
                  "–"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
