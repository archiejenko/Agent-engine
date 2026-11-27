import type { PanelResult } from "@ae/contracts";
import "./kit.css";
import type { ReactNode } from "react";
import { KindBadge, when } from "./format.tsx";

/** True when the result carries nothing to draw (its empty state says what will fill it). */
export function isEmpty(r: PanelResult): boolean {
  const payload = r[r.kind] as unknown[] | undefined;
  return !payload || payload.length === 0;
}

/**
 * The frame every panel sits in: title, refreshed-at time, a placeholder while loading, an error with
 * a retry button, an empty state that says what fills it, and a drill link. A failing panel only
 * shows its error here; the rest of the page renders as normal (design rule 6).
 */
export function Panel({
  title,
  span = 4,
  drill,
  status,
  result,
  error,
  onRetry,
  count,
  seeAll,
  children,
}: {
  title: string;
  /** A total shown beside the title (e.g. open decisions), from the API's meta. */
  count?: number | null;
  /** "See all (N)": shown when the panel holds fewer rows than exist. */
  seeAll?: { href: string; total: number } | null;
  span?: number;
  drill?: string | null;
  status: "loading" | "ok" | "error";
  result: PanelResult | null;
  error?: string | null;
  onRetry?: () => void;
  children: (r: PanelResult) => ReactNode;
}) {
  return (
    <section
      className={`panel span-${span}`}
      data-panel-state={status}
      aria-busy={status === "loading"}
      aria-label={title}
    >
      <header className="panel-head">
        <h3>
          {title}
          {count !== undefined && count !== null && (
            <span className="panel-count num" title={`${count} in all`}>
              {count}
            </span>
          )}
        </h3>
        {result?.value_kind && !isEmpty(result) && <KindBadge kind={result.value_kind} />}
        {seeAll ? (
          <a className="panel-drill" href={`#${seeAll.href}`}>
            See all ({seeAll.total}) ›
          </a>
        ) : (
          drill && (
            <a className="panel-drill" href={`#${drill}`} aria-label={`Open ${title}`}>
              Open ›
            </a>
          )
        )}
      </header>
      {status === "error" ? (
        <div className="panel-error" role="alert">
          <p>Couldn't load this panel: {error}</p>
          {onRetry && (
            <button type="button" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      ) : !result ? (
        <div className="panel-skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : isEmpty(result) ? (
        <p className="panel-empty">{result.empty}</p>
      ) : (
        children(result)
      )}
      {result && status !== "error" && (
        <footer className="panel-foot">
          {result.note && <span>{result.note}</span>}
          <span className="panel-asof">refreshed {when(result.as_of)}</span>
        </footer>
      )}
    </section>
  );
}
