import type { PanelStage } from "@ae/contracts";
import { Fragment } from "react";
import { fmtRatio, KindBadge } from "./format.tsx";

/**
 * Stage bars with counts, and the conversion from the stage before where the API gives one. Where the
 * unit changes (ideas → revenue paths) a divider says the two halves count different things.
 */
export function Funnel({ stages }: { stages: PanelStage[] }) {
  return (
    <ol className="funnel">
      {stages.map((s, i) => {
        const before = stages[i - 1];
        const unitChanges = before !== undefined && before.unit !== s.unit;
        return (
          <Fragment key={s.key}>
            {unitChanges && (
              <li className="funnel-divider">
                <span>
                  From here on: {s.unit}, not {before.unit}. The two halves count different things.
                </span>
              </li>
            )}
            <li>
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
          </Fragment>
        );
      })}
    </ol>
  );
}
