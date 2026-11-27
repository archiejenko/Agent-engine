import type { PanelRow } from "@ae/contracts";
import { fmtRatio, KindBadge } from "./format.tsx";

/** A strip of small stat cards: sent, replies and positive-reply rate per playbook or test. */
export function StatStrip({ rows }: { rows: PanelRow[] }) {
  return (
    <ul className="stat-strip">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="stat-head">
            <b>{r.label}</b> <KindBadge kind={r.kind} />
          </div>
          <dl>
            <div>
              <dt>Sent</dt>
              <dd className="num">{r.sent as number}</dd>
            </div>
            <div>
              <dt>Replies</dt>
              <dd className="num">
                {r.replies as number}{" "}
                <small className="muted">{fmtRatio(r.reply_rate as number | null)}</small>
              </dd>
            </div>
            <div>
              <dt>Positive</dt>
              <dd className="num">
                {r.positive as number}{" "}
                <small className="muted">{fmtRatio(r.positive_rate as number | null)}</small>
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}
