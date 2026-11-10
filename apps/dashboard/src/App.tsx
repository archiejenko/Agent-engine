import { useEffect, useState } from "react";
import { Company } from "./Company.tsx";
import { Controls } from "./Controls.tsx";
import { Facts } from "./Facts.tsx";
import { useTableLabels } from "./format.tsx";
import { Golden } from "./Golden.tsx";
import { Letters } from "./Letters.tsx";
import { Metrics } from "./Metrics.tsx";
import { Overview } from "./Overview.tsx";
import { Review } from "./Review.tsx";

/** Tiny hash router: #/, #/facts, #/company/01234567. Functional, not pretty (Phase 1). */
function useRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.slice(1);
}

const NAV: [string, string][] = [
  ["/", "Overview"],
  ["/review", "Review"],
  ["/letters", "Letters"],
  ["/facts", "Facts"],
  ["/metrics", "Metrics"],
  ["/golden", "Golden set"],
  ["/controls", "Controls"],
];

export function App() {
  const route = useRoute();
  useTableLabels();
  const company = route.match(/^\/company\/([A-Za-z0-9]{8})/)?.[1];
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
      {company ? (
        <Company id={company} />
      ) : route.startsWith("/review") ? (
        <Review />
      ) : route.startsWith("/letters") ? (
        <Letters />
      ) : route.startsWith("/metrics") ? (
        <Metrics />
      ) : route.startsWith("/golden") ? (
        <Golden />
      ) : route.startsWith("/controls") ? (
        <Controls />
      ) : route.startsWith("/facts") ? (
        <Facts />
      ) : (
        <Overview />
      )}
    </main>
  );
}
