import { useCallback, useEffect, useState } from "react";
import { day, type Fact, getJson, short } from "./api.ts";

interface TraceItem {
  signal_id: string;
  raw_value: number | null;
  normalised: number;
  weight: number;
  contribution: number;
  fact_ids: string[];
}
interface Opp {
  opportunity_id: string;
  module: string;
  score: number;
  expected_value_gbp: number;
  confidence: number;
  explore: boolean;
  rationale: string | null;
  trace: TraceItem[];
}
interface QueueItem {
  entity_id: string;
  name?: string;
  best_score: number;
  best_expected_value_gbp: number;
  explore: boolean;
  opportunities: Opp[];
}
interface Draft {
  task_id: string;
  cost_gbp: number;
  awaiting: { kind: "gate" | "check_failed"; item: unknown } | null;
  brief: {
    company_name: string;
    facts: { fact_id: string; statement: string; confidence: number }[];
  } | null;
  pending_decision: unknown;
}
interface ReviewData {
  opportunities: QueueItem[];
  drafts: Draft[];
  conflicts: Fact[];
  quarantine: { id: string; source: string; raw_ref: string; reason: string; record: unknown }[];
}

async function post(path: string, body: unknown) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
}

/** One review queue across everything that needs Archie: leads, drafts, conflicts, quarantined matches. */
export function Review() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<ReviewData>("/api/review")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const act = (p: Promise<unknown>) => p.then(load).catch((e: Error) => setError(e.message));
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <h2>Drafts waiting for you ({data.drafts.length})</h2>
      {data.drafts.length === 0 && <p>Nothing to approve.</p>}
      {data.drafts.map((d) => (
        <DraftCard
          key={d.task_id}
          d={d}
          onDecide={(decision, text) =>
            act(post(`/api/tasks/${d.task_id}/decision`, { decision, edited_text: text }))
          }
        />
      ))}

      <h2>Leads ({data.opportunities.length})</h2>
      {data.opportunities.map((q) => (
        <div
          key={q.entity_id}
          style={{ border: "1px solid #ddd", padding: "0.5rem", marginBottom: "0.5rem" }}
        >
          <b>{q.name}</b> <a href={`#/company/${q.entity_id}`}>{q.entity_id}</a> · score{" "}
          {q.best_score.toFixed(2)} · EV £{q.best_expected_value_gbp.toFixed(0)}{" "}
          {q.explore && <em>(exploration pick)</em>}
          {q.opportunities.map((o) => (
            <div key={o.opportunity_id} style={{ fontSize: "0.85rem", marginTop: "0.3rem" }}>
              <div>
                {o.module} · confidence {o.confidence.toFixed(2)}{" "}
                {o.rationale && <>· {o.rationale}</>}
              </div>
              <table cellPadding={2} style={{ fontSize: "0.8rem" }}>
                <tbody>
                  {o.trace.map((t) => (
                    <tr key={t.signal_id}>
                      <td>{t.signal_id}</td>
                      <td>{t.raw_value === null ? "unknown (neutral)" : t.raw_value}</td>
                      <td>× {t.weight}</td>
                      <td>= {t.contribution.toFixed(3)}</td>
                      <td style={{ color: "#888" }}>{t.fact_ids.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                onClick={() =>
                  act(
                    post(`/api/opportunities/${o.opportunity_id}/decision`, {
                      decision: "approve",
                    }),
                  )
                }
              >
                Approve → draft email
              </button>{" "}
              <button
                type="button"
                onClick={() =>
                  act(
                    post(`/api/opportunities/${o.opportunity_id}/decision`, { decision: "reject" }),
                  )
                }
              >
                Reject
              </button>
            </div>
          ))}
        </div>
      ))}

      <h2>Conflicts ({data.conflicts.length})</h2>
      {data.conflicts.map((f) => (
        <p key={`${f.entity_id}.${f.field}`}>
          <a href={`#/company/${f.entity_id}`}>{f.entity_id}</a> · {f.field}: {short(f.value)}{" "}
          (since {day(f.valid_from)}) — open the company to compare the claims.
        </p>
      ))}

      <h2>Quarantined matches ({data.quarantine.length})</h2>
      {data.quarantine.map((q) => (
        <p key={q.id}>
          {q.source} · {q.raw_ref} · {q.reason}{" "}
          <button
            type="button"
            onClick={() => act(post(`/api/quarantine/${q.id}/resolve`, { entity_id: null }))}
          >
            Not a match
          </button>
        </p>
      ))}
    </>
  );
}

function DraftCard({
  d,
  onDecide,
}: {
  d: Draft;
  onDecide: (decision: "approve" | "edit" | "reject", text: string | null) => void;
}) {
  const item = (
    d.awaiting?.kind === "check_failed"
      ? (d.awaiting.item as { draft: unknown }).draft
      : d.awaiting?.item
  ) as { subject: string; body: string; claims: { fact_id: string; text: string }[] } | undefined;
  const [text, setText] = useState(item?.body ?? "");
  if (!item) return null;
  return (
    <div
      style={{
        border: "1px solid #ccc",
        padding: "0.75rem",
        marginBottom: "0.75rem",
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: "1rem",
      }}
    >
      <div>
        {d.awaiting?.kind === "check_failed" && (
          <p style={{ color: "crimson" }}>
            Failed its check twice:{" "}
            {((d.awaiting.item as { reasons: string[] }).reasons ?? []).join("; ")}
          </p>
        )}
        <b>{item.subject}</b>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          style={{ width: "100%" }}
        />
        <p style={{ fontSize: "0.8rem", color: "#666" }}>
          Cost so far £{d.cost_gbp.toFixed(4)} · sender details and opt-out are added automatically
        </p>
        {d.pending_decision ? (
          <em>Decision recorded; the runner will apply it.</em>
        ) : (
          <>
            <button
              type="button"
              onClick={() =>
                onDecide(text === item.body ? "approve" : "edit", text === item.body ? null : text)
              }
            >
              {text === item.body ? "Approve" : "Save edit & approve"}
            </button>{" "}
            <button type="button" onClick={() => onDecide("reject", null)}>
              Reject
            </button>
          </>
        )}
      </div>
      <div style={{ fontSize: "0.85rem" }}>
        <b>Evidence for each claim</b>
        {item.claims.map((c) => {
          const f = d.brief?.facts.find((x) => x.fact_id === c.fact_id);
          return (
            <div key={c.fact_id} style={{ marginTop: "0.4rem" }}>
              “{c.text}” ← <code>{c.fact_id}</code>{" "}
              {f && <>(confidence {f.confidence.toFixed(2)})</>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
