import { useEffect, useState } from "react";
import { Company } from "./Company.tsx";
import { Facts } from "./Facts.tsx";
import { Overview } from "./Overview.tsx";

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

export function App() {
  const route = useRoute();
  const company = route.match(/^\/company\/([A-Za-z0-9]{8})/)?.[1];
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 1100,
        margin: "1.5rem auto",
        padding: "0 1rem",
      }}
    >
      <header
        style={{
          display: "flex",
          gap: "1.5rem",
          alignItems: "baseline",
          borderBottom: "1px solid #ddd",
          marginBottom: "1rem",
        }}
      >
        <h1 style={{ fontSize: "1.3rem" }}>Agent Engine</h1>
        <a href="#/">Overview</a>
        <a href="#/facts">Facts</a>
      </header>
      {company ? <Company id={company} /> : route.startsWith("/facts") ? <Facts /> : <Overview />}
    </main>
  );
}
