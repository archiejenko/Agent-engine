import { useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface DigestData {
  day: string;
  happened: Record<string, number>;
  earned_gbp: number;
  spent_gbp: number;
  waiting: { open: number };
  defaulted: { id: string; summary: string }[];
  decided: number;
  label: string;
}

/** Yesterday in one line: what happened, money in and out, what's waiting. */
export function Digest() {
  const [d, setD] = useState<DigestData | null>(null);
  useEffect(() => {
    getJson<DigestData>("/api/digest").then(setD, () => setD(null));
  }, []);
  if (!d) return null;
  const events = Object.entries(d.happened)
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
    .join(", ");
  return (
    <p className="card" style={{ padding: "0.6rem" }}>
      <b>{d.day}:</b> {events || "nothing happened"}. Earned £{d.earned_gbp.toFixed(2)}, spent £
      {d.spent_gbp.toFixed(2)}. {d.decided} decided, {d.defaulted.length} defaulted,{" "}
      {d.waiting.open} waiting.
      {d.label !== "real" && <span className="kind kind-synthetic">SIMULATED</span>}
    </p>
  );
}
