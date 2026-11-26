import type { PanelStage } from "@ae/contracts";
import { fmtRatio, KindBadge } from "./format.tsx";

/** Stage bars with counts, and the conversion from the stage before where the API gives one. */
export function Funnel({ stages }: { stages: PanelStage[] }) {
  return (
    <ol className="funnel">
      {stages.map((s) => (
        <li key={s.key}>
          <div className="funnel-label">
            <span>{s.label}</span>
            <span className="num">
              <b>{s.count}</b> <small className="muted">{s.unit}</small>
            </span>
          </div>
          <div className="funnel-track">
            <div className="funnel-bar" style={{ transform: `scaleX(${s.share})` }} />
          </div>
          <div className="funnel-meta muted">
            {s.rate_from_previous !== null && (
              <>{fmtRatio(s.rate_from_previous)} of the stage before · </>
            )}
            <KindBadge kind={s.kind} />
            {s.note && <> · {s.note}</>}
          </div>
        </li>
      ))}
    </ol>
  );
}
