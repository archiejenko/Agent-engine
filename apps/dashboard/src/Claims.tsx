import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";
import { recordReview } from "./reviewTimer.ts";

interface Claim {
  id: string;
  entity_id: string;
  email: string;
  status: string;
  setup_fee_gbp: number;
  monthly_gbp: number;
  human_minutes: number;
  details: {
    submitted?: { business_description: string; area: string };
    draft?: { headline: string; about: string; services: string[] };
    problems?: string[];
  } | null;
  updated_at: string;
}
interface ClaimsData {
  human_minutes_target: number;
  claims: Claim[];
}

const STATUS: Record<string, string> = {
  checkout_started: "at checkout",
  paid: "paid · waiting for their details",
  details_received: "details received · drafting",
  awaiting_publish: "draft ready for you",
  published: "live",
  cancelled: "cancelled",
  refunded: "refunded",
};

/** Claimed sites: what each is waiting for, the draft to approve, and your minutes against the target. */
export function Claims() {
  const [d, setD] = useState<ClaimsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<ClaimsData>("/api/claims").then(setD, (e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);
  if (!d) return <p>{msg ?? "Loading…"}</p>;
  const decide = async (c: Claim, approve: boolean) => {
    recordReview("claim", c.id);
    const r = await fetch(`/api/claims/${c.id}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approve }),
    });
    setMsg(
      r.ok
        ? approve
          ? "Approved: publishing."
          : "Sent back."
        : ((await r.json()).error ?? `HTTP ${r.status}`),
    );
    load();
  };
  return (
    <>
      <h2>Claimed sites</h2>
      {msg && <p className="muted">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th align="left">Company</th>
            <th align="left">Status</th>
            <th>Price</th>
            <th>Your minutes</th>
          </tr>
        </thead>
        <tbody>
          {d.claims.length === 0 && <EmptyRow cols={4}>No claims yet.</EmptyRow>}
          {d.claims.map((c) => (
            <tr key={c.id}>
              <td>{c.entity_id}</td>
              <td>
                {STATUS[c.status] ?? c.status}
                {c.status === "awaiting_publish" && c.details?.draft && (
                  <div className="card">
                    <b>{c.details.draft.headline}</b>
                    <p>{c.details.draft.about}</p>
                    <p>{c.details.draft.services.join(" · ")}</p>
                    {(c.details.problems ?? []).length > 0 && (
                      <p style={{ color: "crimson" }}>
                        Check: {(c.details.problems ?? []).join("; ")}
                      </p>
                    )}
                    <button type="button" className="primary" onClick={() => decide(c, true)}>
                      Approve and publish
                    </button>{" "}
                    <button type="button" onClick={() => decide(c, false)}>
                      Not yet
                    </button>
                  </div>
                )}
              </td>
              <td align="right">
                £{c.setup_fee_gbp.toFixed(0)} + £{c.monthly_gbp.toFixed(0)}/mo
              </td>
              <td
                align="right"
                style={{ color: c.human_minutes > d.human_minutes_target ? "crimson" : undefined }}
              >
                {c.human_minutes} / {d.human_minutes_target}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
