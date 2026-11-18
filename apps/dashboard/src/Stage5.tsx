import { useEffect, useState } from "react";
import { getJson } from "./api.ts";

/** Stage 5 (cutover): a read-only summary of the latest real drafts. Hidden until real drafts exist. */
interface Review {
  drafts: number;
  by_playbook: Record<string, number>;
  models: Record<string, string[]>;
  first_time_pass_rate: number | null;
  passed_after_retry: number;
  failed_twice: number;
  rejection_reasons: { reason: string; count: number }[];
  cost_per_draft_gbp: { mean: number | null; max: number | null };
  decisions: { approved: number; edited: number; rejected: number; waiting: number };
  edit_rate: number | null;
  repeated_phrases: { phrase: string; drafts: number; everywhere: boolean }[];
}
const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const gbp = (x: number | null) => (x === null ? "—" : `£${x.toFixed(3)}`);

export function Stage5Card() {
  const [r, setR] = useState<Review | null>(null);
  useEffect(() => {
    getJson<Review>("/api/review/stage5").then(setR, () => setR(null));
  }, []);
  if (!r || r.drafts === 0) return null;
  return (
    <details className="card" open>
      <summary>
        <b>Stage 5 review: the latest {r.drafts} real drafts</b>
      </summary>
      <p className="muted">
        {Object.entries(r.by_playbook)
          .map(([k, v]) => `${v} ${k.replace("sme_", "")}`)
          .join(", ")}{" "}
        · writer: {(r.models.writer ?? []).join(", ") || "—"}
      </p>
      <p>
        Checker passed first time: <b>{pct(r.first_time_pass_rate)}</b> · passed after one retry:{" "}
        {r.passed_after_retry} · failed twice: {r.failed_twice}
        <br />
        Cost per draft: <b>{gbp(r.cost_per_draft_gbp.mean)}</b> (max {gbp(r.cost_per_draft_gbp.max)}
        ) · your edit rate: <b>{pct(r.edit_rate)}</b> ({r.decisions.approved} approved,{" "}
        {r.decisions.edited} edited, {r.decisions.rejected} rejected, {r.decisions.waiting} waiting)
      </p>
      {r.rejection_reasons.length > 0 && (
        <>
          <p className="muted">Why the checker rejected drafts:</p>
          <ul>
            {r.rejection_reasons.slice(0, 8).map((x) => (
              <li key={x.reason}>
                {x.reason} — {x.count}
              </li>
            ))}
          </ul>
        </>
      )}
      {r.repeated_phrases.filter((p) => !p.everywhere).length > 0 && (
        <>
          <p className="muted">Phrases repeated across drafts (the checker doesn't catch these):</p>
          <ul>
            {r.repeated_phrases
              .filter((p) => !p.everywhere)
              .slice(0, 10)
              .map((p) => (
                <li key={p.phrase}>
                  “{p.phrase}” — in {p.drafts} drafts
                </li>
              ))}
          </ul>
        </>
      )}
    </details>
  );
}
