import type { PanelRow } from "@ae/contracts";
import { fmtRatio, money } from "./format.tsx";

const LEVELS = ["L0", "L1", "L2", "L3"];
const LEVEL_NAME: Record<string, string> = {
  L0: "drafts only",
  L1: "acts after approval",
  L2: "acts within limits",
  L3: "automatic",
};

/**
 * Per playbook: spent today against its cap as a gauge (fill = the API's cap_used), and autonomy as
 * four steps L0–L3 with the current level lit. Display only: kill switches stay in Controls' table.
 */
export function Gauges({ rows }: { rows: PanelRow[] }) {
  return (
    <ul className="gauges">
      {rows.map((r) => {
        const used = (r.cap_used as number | null | undefined) ?? 0;
        const level = (r.autonomy as string) ?? "L0";
        return (
          <li key={r.key} className={r.killed ? "killed" : undefined}>
            <div className="gauge-head">
              <b>{r.label}</b>
              {r.killed ? <span className="pill off">killed</span> : null}
              <span className="muted num">
                {money(r.spent_today_gbp as number)} of {money(r.cap_today_gbp as number)} today
              </span>
            </div>
            <meter className="sr-only" min={0} max={1} value={used}>
              {`${r.label}: ${fmtRatio(used)} of today's cap`}
            </meter>
            <div
              className={`gauge ${used >= 1 ? "full" : used >= 0.8 ? "high" : ""}`}
              aria-hidden="true"
            >
              <div className="gauge-fill" style={{ transform: `scaleX(${Math.min(1, used)})` }} />
            </div>
            <ol
              className="autonomy-steps"
              aria-label={`Autonomy ${level}: ${LEVEL_NAME[level] ?? ""}`}
            >
              {LEVELS.map((l) => (
                <li
                  key={l}
                  className={
                    l === level ? "on" : LEVELS.indexOf(l) < LEVELS.indexOf(level) ? "past" : ""
                  }
                >
                  {l}
                </li>
              ))}
            </ol>
            <div className="muted kanban-detail">
              {level}: {LEVEL_NAME[level] ?? level} · tier {String(r.tier ?? "–")}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
