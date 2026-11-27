import type { PanelRow } from "@ae/contracts";
import { fmtRatio, KindBadge, money } from "./format.tsx";

/**
 * Ranked playbooks with an inline bar (length from the API's bar_share), autonomy and cap use. A table
 * on wider screens; one compact card per playbook on a phone (CSS picks which shows).
 */
export function Leaderboard({ rows }: { rows: PanelRow[] }) {
  return (
    <>
      <LeaderboardCards rows={rows} />
      <LeaderboardTable rows={rows} />
    </>
  );
}

function LeaderboardCards({ rows }: { rows: PanelRow[] }) {
  return (
    <ol className="lb-cards">
      {rows.map((r) => (
        <li key={r.key} className={r.killed ? "killed" : undefined}>
          <div className="lb-card-head">
            <span className="lb-rank num">{r.rank as number}</span>
            {r.drill ? <a href={`#${r.drill}`}>{r.label}</a> : <span>{r.label}</span>}
            {r.killed ? <span className="pill off">killed</span> : null}
            <span className="lb-net num">
              {money(r.net_gbp as number)} <KindBadge kind={r.kind} />
            </span>
          </div>
          <div className="lb-track">
            <div
              className={`lb-bar ${(r.net_gbp as number) < 0 ? "neg" : ""}`}
              style={{ transform: `scaleX(${(r.bar_share as number) ?? 0})` }}
            />
          </div>
          <div className="lb-card-meta muted num">
            {money(r.revenue_gbp as number)} in · {money(r.spend_gbp as number)} out · ROI{" "}
            {fmtRatio(r.roi as number | null)} · {(r.autonomy as string) ?? "–"}
            {r.cap_today_gbp !== undefined && (
              <>
                {" "}
                · cap {fmtRatio(r.cap_used as number | null)} of {money(r.cap_today_gbp as number)}
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function LeaderboardTable({ rows }: { rows: PanelRow[] }) {
  return (
    <div className="table-scroll lb-table">
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
