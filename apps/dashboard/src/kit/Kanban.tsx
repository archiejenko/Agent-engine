import type { PanelFigure, PanelRow, PanelStage } from "@ae/contracts";
import { useState } from "react";
import { decide } from "./DecisionCard.tsx";
import { fmt, KindBadge, money } from "./format.tsx";

interface CardDecision {
  id: string;
  options: { key: string; label: string; effect: string }[];
  recommended: string;
  /** Options that need Archie's reason (e.g. failing an idea: the planner reads it). */
  reason_for?: string[];
}

/** One card on a board: title (opens it), detail, its figures with their kinds, and any decision. */
function BoardCard({ r, onDecided }: { r: PanelRow; onDecided?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const d = r.decision as CardDecision | null | undefined;
  const choose = async (key: string) => {
    if (!d) return;
    let reason: string | null = null;
    if (d.reason_for?.includes(key)) {
      reason = window.prompt("Why? The planner reads your reason.")?.trim() || null;
      if (!reason) return setMsg("A reason is needed for that.");
    }
    setBusy(true);
    const err = await decide(d.id, key, reason ? { reason } : {});
    setBusy(false);
    setMsg(err ? `Not done: ${err}` : "Done");
    if (!err) onDecided?.();
  };
  const figures = (r.figures as PanelFigure[] | undefined) ?? [];
  return (
    <li className="kanban-card">
      <div className="kanban-title">
        {r.drill ? <a href={`#${r.drill}`}>{r.label}</a> : r.label}
        {r.kind === "synthetic" && <KindBadge kind="synthetic" />}
      </div>
      {r.detail && <div className="muted kanban-detail">{r.detail}</div>}
      {typeof r.plan_status === "string" && (
        <div className="muted kanban-detail">plan: {r.plan_status}</div>
      )}
      {figures.length > 0 && (
        <dl className="kanban-figures">
          {figures.map((f) => (
            <div key={f.key}>
              <dt>{f.label}</dt>
              <dd className="num">
                {fmt(f.value, f.unit)} {f.value !== null && <KindBadge kind={f.kind} />}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {d && (
        <div className="decision-actions">
          {d.options.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={busy}
              title={o.effect}
              className={o.key === d.recommended ? "primary" : undefined}
              onClick={() => choose(o.key)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      {msg && <div className="muted kanban-detail">{msg}</div>}
    </li>
  );
}

/**
 * Columns of cards (Ideas: new → killed; CRM: pipeline stages). Column counts, values and notes come
 * from the API's stages; cards are the rows, each tagged with its column. Wide boards scroll inside
 * the panel, never the page; on a phone the columns stack.
 */
export function Kanban({
  stages,
  rows,
  onDecided,
}: {
  stages: PanelStage[];
  rows: PanelRow[];
  onDecided?: () => void;
}) {
  return (
    <div className="kanban">
      {stages.map((st) => {
        const cards = rows.filter((r) => r.column === st.key);
        return (
          <section key={st.key} className="kanban-col" aria-label={st.label}>
            <header>
              <b>{st.label}</b> <span className="num muted">{st.count}</span>
              {st.value_gbp !== undefined && st.value_gbp !== null && (
                <span className="num kanban-value">
                  {money(st.value_gbp, { whole: true })} <KindBadge kind={st.kind} />
                </span>
              )}
            </header>
            {st.note && <div className="muted kanban-detail">{st.note}</div>}
            <ul>
              {cards.map((r) => (
                <BoardCard key={r.key} r={r} {...(onDecided ? { onDecided } : {})} />
              ))}
              {cards.length === 0 && <li className="muted kanban-empty">None</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
