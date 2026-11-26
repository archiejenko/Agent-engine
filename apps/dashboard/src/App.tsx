import { lazy, Suspense, useEffect, useState } from "react";
import { Board } from "./Board.tsx";
import { Controls } from "./Controls.tsx";
import { Crm } from "./Crm.tsx";
import { useTableLabels } from "./format.tsx";
import { Home } from "./Home.tsx";
import { Ideas } from "./Ideas.tsx";
import { Inbox } from "./Inbox.tsx";
import { ControlsTabs, Keys } from "./Keys.tsx";
import { Plan } from "./Plan.tsx";
import { Vault } from "./Vault.tsx";

// The cockpit kit (and its chart library) loads only when a page that uses it opens.
const KitPage = lazy(() => import("./kit/KitPage.tsx").then((m) => ({ default: m.KitPage })));

/** Tiny hash router. v3: seven pages; old links redirect to where their content moved. */
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.slice(1);
}

export const NAV: [string, string][] = [
  ["/", "Home"],
  ["/ideas", "Ideas"],
  ["/board", "Board"],
  ["/vault", "Vault"],
  ["/crm", "CRM"],
  ["/inbox", "Inbox"],
  ["/controls", "Controls"],
];

/** Old (v2) routes → new homes. */
export function redirectOf(route: string): string | null {
  const company = route.match(/^\/company\/([A-Za-z0-9]{8})/)?.[1];
  if (company) return `/crm/${company}`;
  const map: Record<string, string> = {
    "/overview": "/",
    "/metrics": "/",
    "/facts": "/crm/facts",
    "/golden": "/crm/verify",
    "/review": "/inbox",
    "/letters": "/inbox/letters",
  };
  return map[route] ?? null;
}

export function App() {
  const raw = useRoute();
  useTableLabels();
  const to = redirectOf(raw);
  useEffect(() => {
    if (to) window.location.replace(`#${to}`);
  }, [to]);
  const route = to ?? raw;
  const active = (path: string) =>
    path === "/" ? route === "/" || route === "" : route.startsWith(path);
  return (
    <main className="app">
      <nav className="top" aria-label="Main">
        <h1>Agent Engine</h1>
        {NAV.map(([path, name]) => (
          <a key={path} href={`#${path}`} className={active(path) ? "active" : undefined}>
            {name}
          </a>
        ))}
      </nav>
      {route.startsWith("/kit") ? (
        // Hidden: the cockpit component kit (not in the navigation).
        <Suspense fallback={<p className="muted">Loading the kit…</p>}>
          <KitPage />
        </Suspense>
      ) : route.startsWith("/crm") ? (
        <Crm route={route} />
      ) : route.startsWith("/inbox") ? (
        <Inbox route={route} />
      ) : route.startsWith("/controls/keys") ? (
        <Keys />
      ) : route.startsWith("/controls") ? (
        <>
          <ControlsTabs tab="controls" />
          <Controls />
        </>
      ) : route.startsWith("/plans/") ? (
        <Plan id={route.slice(7)} />
      ) : route.startsWith("/ideas") ? (
        <Ideas route={route} />
      ) : route.startsWith("/board") ? (
        <Board />
      ) : route.startsWith("/vault") ? (
        <Vault route={route} />
      ) : (
        <Home />
      )}
    </main>
  );
}
