import { useCallback, useEffect, useState } from "react";

/**
 * The filter bar's choice lives in the URL hash (after "?"), so a view is shareable and survives a
 * reload: e.g. #/kit?period=7&compare=0. Default (Archie, 26 Nov): last 30 days, live only, compare on.
 * Dates for presets are worked out by the API (`days`), not here.
 */
export interface Filters {
  period: "7" | "30" | "90" | "custom";
  from: string | null;
  to: string | null;
  playbook: string | null;
  synthetic: boolean;
  compare: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  period: "30",
  from: null,
  to: null,
  playbook: null,
  synthetic: false,
  compare: true,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z][a-z0-9_]*$/;

export function parseFilters(hash: string): Filters {
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const period = q.get("period");
  const from = q.get("from");
  const to = q.get("to");
  const playbook = q.get("playbook");
  const custom = period === "custom" && from && DATE.test(from);
  return {
    period: custom ? "custom" : period === "7" || period === "90" ? period : "30",
    from: custom ? from : null,
    to: custom && to && DATE.test(to) ? to : null,
    playbook: playbook && SLUG.test(playbook) ? playbook : null,
    synthetic: q.get("synthetic") === "1",
    compare: q.get("compare") !== "0",
  };
}

/** The hash query for a filter choice; defaults are left out so plain links stay short. */
export function hashQuery(f: Filters): string {
  const q = new URLSearchParams();
  if (f.period !== "30") q.set("period", f.period);
  if (f.period === "custom") {
    if (f.from) q.set("from", f.from);
    if (f.to) q.set("to", f.to);
  }
  if (f.playbook) q.set("playbook", f.playbook);
  if (f.synthetic) q.set("synthetic", "1");
  if (!f.compare) q.set("compare", "0");
  return q.toString();
}

/** The API parameters for a filter choice. */
export function filterParams(f: Filters): Record<string, string> {
  const p: Record<string, string> = {
    compare: f.compare ? "1" : "0",
    synthetic: f.synthetic ? "1" : "0",
  };
  if (f.period === "custom" && f.from) {
    p.from = f.from;
    if (f.to) p.to = f.to;
  } else p.days = f.period === "custom" ? "30" : f.period;
  if (f.playbook) p.playbook = f.playbook;
  return p;
}

/** Filters from the hash, and a setter that writes them back (keeping the route before "?"). */
export function useFilters(): [Filters, (f: Filters) => void] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const set = useCallback((f: Filters) => {
    const route = (window.location.hash.slice(1) || "/").split("?")[0];
    const q = hashQuery(f);
    window.location.hash = q ? `${route}?${q}` : (route ?? "/");
  }, []);
  return [parseFilters(hash), set];
}
