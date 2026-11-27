import { lazy, Suspense, useEffect } from "react";
import { Digest } from "./Digest.tsx";
import { Metrics } from "./Metrics.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { Overview } from "./Overview.tsx";

/** The cockpit and its chart library are one chunk; Home starts fetching it the moment it mounts. */
const loadCockpit = () => import("./kit/Cockpit.tsx");
const Cockpit = lazy(() => loadCockpit().then((m) => ({ default: m.Cockpit })));
const AllFigures = lazy(() => loadCockpit().then((m) => ({ default: m.AllFigures })));

export type HomeTab = "cockpit" | "queue" | "quality";

/** The tab from the hash query (#/?tab=queue), so "See all" links and reloads land on it. */
export function homeTab(route: string): HomeTab {
  const tab = new URLSearchParams(route.split("?")[1] ?? "").get("tab");
  return tab === "queue" || tab === "quality" ? tab : "cockpit";
}

function tabHref(tab: HomeTab): string {
  const [, query] = (window.location.hash.slice(1) || "/").split("?");
  const q = new URLSearchParams(query ?? "");
  if (tab === "cockpit") q.delete("tab");
  else q.set("tab", tab);
  const s = q.toString();
  return s ? `#/?${s}` : "#/";
}

const TABS: [HomeTab, string][] = [
  ["cockpit", "Cockpit"],
  ["queue", "Needs you (all)"],
  ["quality", "Quality"],
];

/**
 * Home (cockpit UI plan §4). Cockpit: the 10-second view, built from home.json. Needs you (all): the
 * full decisions queue the cockpit's "See all" opens. Quality: the old "Data and today" and "Quality,
 * lift and unit economics" sections, the daily digest and every figure; nothing was removed.
 */
export function Home({ route }: { route: string }) {
  const tab = homeTab(route);
  useEffect(() => {
    void loadCockpit();
  }, []);
  return (
    <>
      <nav className="tabs" aria-label="Home">
        {TABS.map(([k, label]) => (
          <a key={k} href={tabHref(k)} aria-current={tab === k ? "page" : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {tab === "queue" ? (
        <NeedsYou />
      ) : tab === "quality" ? (
        <>
          <h2>All figures</h2>
          <Suspense
            fallback={
              <p className="muted" data-panel-state="loading">
                Loading the figures…
              </p>
            }
          >
            <AllFigures />
          </Suspense>
          <Digest />
          <h2>Data and today</h2>
          <Overview />
          <h2>Quality, lift and unit economics</h2>
          <Metrics />
        </>
      ) : (
        <Suspense
          fallback={
            <p className="muted" data-panel-state="loading">
              Loading the cockpit…
            </p>
          }
        >
          <Cockpit />
        </Suspense>
      )}
    </>
  );
}
