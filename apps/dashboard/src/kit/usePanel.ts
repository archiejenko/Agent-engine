import type { PanelResult } from "@ae/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Filters, filterParams } from "./filters.ts";

export type PanelState =
  | { status: "loading"; result: PanelResult | null; error: null }
  | { status: "ok"; result: PanelResult; error: null }
  | { status: "error"; result: PanelResult | null; error: string };

/**
 * One panel's data (cockpit UI plan §3.4). Each panel fetches on its own, so one failing panel never
 * affects another. Refreshes every `refreshS` seconds while the tab is visible (0 = never), and again
 * when the tab comes back after missing a refresh. A changed query, argument or filter refetches.
 */
export function usePanel(
  query: string,
  args: Record<string, string | number | boolean>,
  filters: Filters,
  refreshS = 0,
): PanelState & { retry: () => void } {
  const params = new URLSearchParams(filterParams(filters));
  for (const [k, v] of Object.entries(args)) params.set(k, String(v));
  params.sort();
  const url = `/api/panels/${encodeURIComponent(query)}?${params.toString()}`;
  const [state, setState] = useState<PanelState>({ status: "loading", result: null, error: null });
  const [tick, setTick] = useState(0);
  const missed = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick is the manual/refresh trigger.
  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ status: "loading", result: s.result, error: null }));
    fetch(url, { signal: ctl.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setState({ status: "ok", result: body as PanelResult, error: null });
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted) return;
        setState((s) => ({ status: "error", result: s.result, error: e.message }));
      });
    return () => ctl.abort();
  }, [url, tick]);

  useEffect(() => {
    if (!refreshS) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
      else missed.current = true;
    }, refreshS * 1000);
    const onVis = () => {
      if (document.visibilityState === "visible" && missed.current) {
        missed.current = false;
        setTick((t) => t + 1);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshS]);

  const retry = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, retry };
}
