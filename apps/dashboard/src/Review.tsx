import { useCallback, useEffect, useState } from "react";
import { day, type Fact, getJson } from "./api.ts";
import { FactValue, label } from "./format.tsx";

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
  /** Only outreach modules can be approved. */
  actionable: boolean;
}
interface QueueItem {
  entity_id: string;
  name?: string;
  best_score: number;
  best_expected_value_gbp: number;
  explore: boolean;
  /** email when we hold an address we may write to, otherwise a letter. */
  route: "email" | "letter";
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

const PAGE = 20;
type Tab = "drafts" | "leads" | "conflicts" | "quarantine";

/** Readable fact reference: "Incorporated (2015-03-02)" instead of the raw fact id. */
function factRef(id: string): string {
  const [, field, from] = id.split("/");
  return field ? `${label(field)}${from ? ` (as of ${from.slice(0, 10)})` : ""}` : id;
}

function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}>
        ‹ Previous
      </button>
      <span>
        Page {page + 1} of {pages} ({total})
      </span>
      <button type="button" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Next ›
      </button>
    </div>
  );
}

/** One review queue across everything that needs Archie, in tabs: drafts, leads, conflicts, quarantine. */
export function Review() {
  const [data, setData] = useState<ReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("drafts");
  const [page, setPage] = useState(0);
  const load = useCallback(() => {
    getJson<ReviewData>("/api/review")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  const act = (p: Promise<unknown>) => p.then(load).catch((e: Error) => setError(e.message));
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!data) return <p>Loading…</p>;
  const counts: Record<Tab, number> = {
    drafts: data.drafts.length,
    leads: data.opportunities.length,
    conflicts: data.conflicts.length,
    quarantine: data.quarantine.length,
  };
  const names: Record<Tab, string> = {
    drafts: "Drafts",
    leads: "Leads",
    conflicts: "Conflicts",
    quarantine: "Quarantine",
  };
  const slice = <T,>(xs: T[]) => xs.slice(page * PAGE, (page + 1) * PAGE);
  return (
    <>
      <h2>Review</h2>
      <div className="tabs" role="tablist">
        {(Object.keys(names) as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setPage(0);
            }}
          >
            {names[t]} ({counts[t]})
          </button>
        ))}
      </div>

      {tab === "drafts" && (
        <>
          {data.drafts.length === 0 && (
            <p className="empty">
              No email drafts waiting. (Letters are approved as a batch on Letters.)
            </p>
          )}
          {slice(data.drafts).map((d) => (
            <DraftCard
              key={d.task_id}
              d={d}
              onDecide={(decision, text) =>
                act(post(`/api/tasks/${d.task_id}/decision`, { decision, edited_text: text }))
              }
            />
          ))}
          <Pager page={page} total={data.drafts.length} onPage={setPage} />
        </>
      )}

      {tab === "leads" && (
        <>
          {data.opportunities.length === 0 && <p className="empty">No leads waiting.</p>}
          {slice(data.opportunities).map((q) => (
            <div key={q.entity_id} className="card">
              <b>{q.name}</b> <a href={`#/company/${q.entity_id}`}>{q.entity_id}</a> · score{" "}
              {q.best_score.toFixed(2)} · EV £{q.best_expected_value_gbp.toFixed(0)}{" "}
              {q.explore && <em>(exploration pick)</em>}
              {q.opportunities.map((o) => (
                <div key={o.opportunity_id} style={{ fontSize: "0.9rem", marginTop: "0.4rem" }}>
                  <div>
                    <b>{o.module}</b> · confidence {o.confidence.toFixed(2)}
                    {o.rationale && <> · {o.rationale}</>}
                  </div>
                  <details>
                    <summary>How the score adds up ({o.trace.length} signals)</summary>
                    <table style={{ fontSize: "0.85rem" }}>
                      <thead>
                        <tr>
                          <th>Signal</th>
                          <th>Value</th>
                          <th className="num">Weight</th>
                          <th className="num">Adds</th>
                          <th>From</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.trace.map((t) => (
                          <tr key={t.signal_id}>
                            <td>{label(t.signal_id)}</td>
                            <td>{t.raw_value === null ? "unknown (neutral)" : t.raw_value}</td>
                            <td className="num">× {t.weight}</td>
                            <td className="num">{t.contribution.toFixed(3)}</td>
                            <td className="muted">{t.fact_ids.map(factRef).join(", ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                  {o.actionable ? (
                    <p style={{ margin: "0.4rem 0 0" }}>
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          act(
                            post(`/api/opportunities/${o.opportunity_id}/decision`, {
                              decision: "approve",
                            }),
                          )
                        }
                      >
                        {q.route === "email" ? "Approve → email" : "Approve → letter"}
                      </button>{" "}
                      <button
                        type="button"
                        onClick={() =>
                          act(
                            post(`/api/opportunities/${o.opportunity_id}/decision`, {
                              decision: "reject",
                            }),
                          )
                        }
                      >
                        Reject
                      </button>
                    </p>
                  ) : (
                    <p className="muted" style={{ margin: "0.3rem 0 0" }}>
                      Read-only: {o.module} shows who is checking this company; it doesn't contact
                      anyone.
                    </p>
                  )}
                </div>
              ))}
            </div>
          ))}
          <Pager page={page} total={data.opportunities.length} onPage={setPage} />
        </>
      )}

      {tab === "conflicts" && (
        <>
          {data.conflicts.length === 0 && (
            <p className="empty">No conflicts: every fact's sources agree.</p>
          )}
          {slice(data.conflicts).map((f) => (
            <p key={`${f.entity_id}.${f.field}`} className="card">
              <a href={`#/company/${f.entity_id}`}>{f.entity_id}</a> · {label(f.field)}:{" "}
              <FactValue field={f.field} value={f.value} max={2} /> (since {day(f.valid_from)}).
              Open the company to compare the claims.
            </p>
          ))}
          <Pager page={page} total={data.conflicts.length} onPage={setPage} />
        </>
      )}

      {tab === "quarantine" && (
        <>
          {data.quarantine.length === 0 && <p className="empty">Nothing in quarantine.</p>}
          {slice(data.quarantine).map((q) => (
            <p key={q.id} className="card">
              {q.source} · {q.raw_ref} · {q.reason}{" "}
              <button
                type="button"
                onClick={() => act(post(`/api/quarantine/${q.id}/resolve`, { entity_id: null }))}
              >
                Not a match
              </button>
            </p>
          ))}
          <Pager page={page} total={data.quarantine.length} onPage={setPage} />
        </>
      )}
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
        gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
        gap: "1rem",
        borderRadius: 8,
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
          rows={12}
          style={{ width: "100%", font: "inherit", lineHeight: 1.5 }}
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
              className="primary"
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
              “{c.text}” ← {factRef(c.fact_id)} {f && <>(confidence {f.confidence.toFixed(2)})</>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
