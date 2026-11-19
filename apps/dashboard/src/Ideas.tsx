import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import type { Decision } from "./NeedsYou.tsx";

interface Figure {
  value: number;
  label: "real" | "estimated" | "assumed";
  assumption: string | null;
}
interface Card {
  card_id: string;
  version: number;
  market: { key: string; buyer: string; industry: string | null };
  offer: string;
  thesis: string;
  taxonomy_node: string;
  route: string;
  lane: string;
  regulated: boolean;
  legal_check: { by: string; note: string } | null;
  evidence: { fact_ids: string[]; signal_ids: string[]; vault_notes: string[] };
  economics: {
    cost_to_serve: Record<string, Figure>;
    cost_to_acquire: Record<string, Figure>;
    first_year_value: Figure;
    payback_months: Figure;
    market_size_companies: Figure;
    expected_profit: Figure;
    owner_hours: Figure;
    profit_per_owner_hour: Figure;
  };
  test: {
    budget_gbp: Figure;
    sample_size: number;
    time_cap_days: number;
    weekly_volume: Figure;
    reachable: boolean;
    days_to_first_gbp: Figure;
  };
  kill_criteria: { metric: string; op: string; threshold: number; by_day: number }[];
  success_criteria: string;
  what_changed: string | null;
}
interface FeedRow {
  card: Card;
  status: string;
  status_reason: string | null;
  synthetic: boolean;
  plan_status: string;
  legal_check_needed: boolean;
  decision: Decision | null;
}
interface ThreadRow {
  id: number;
  version: number;
  kind: string;
  author: string;
  text: string;
  evidence: string[];
  created_at: string;
}

const gbp = (n: number) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

/** One figure with its label; anything not real shows its assumption on hover and underneath. */
function Fig({ f, money = true, unit = "" }: { f: Figure; money?: boolean; unit?: string }) {
  return (
    <span title={f.assumption ?? "real"}>
      {money ? gbp(f.value) : `${Math.round(f.value * 100) / 100}${unit}`}{" "}
      <span className={`kind kind-${f.label}`}>{f.label}</span>
    </span>
  );
}

function Economics({ c }: { c: Card }) {
  const e = c.economics;
  const rows: [string, React.ReactNode, Figure][] = [
    [
      "Profit per hour of your time",
      <Fig key="a" f={e.profit_per_owner_hour} />,
      e.profit_per_owner_hour,
    ],
    ["Expected profit (the test)", <Fig key="b" f={e.expected_profit} />, e.expected_profit],
    ["Your hours", <Fig key="c" f={e.owner_hours} money={false} unit=" h" />, e.owner_hours],
    [
      "Cost to serve one customer",
      <Fig key="d" f={e.cost_to_serve.total as Figure} />,
      e.cost_to_serve.total as Figure,
    ],
    [
      "Cost to acquire one customer",
      <Fig key="e" f={e.cost_to_acquire.total as Figure} />,
      e.cost_to_acquire.total as Figure,
    ],
    [
      "Sends needed per sale",
      <Fig key="f" f={e.cost_to_acquire.sends_needed as Figure} money={false} />,
      e.cost_to_acquire.sends_needed as Figure,
    ],
    ["First-year value", <Fig key="g" f={e.first_year_value} />, e.first_year_value],
    [
      "Payback",
      <Fig key="h" f={e.payback_months} money={false} unit=" months" />,
      e.payback_months,
    ],
    [
      "Market size",
      <Fig key="i" f={e.market_size_companies} money={false} unit=" companies" />,
      e.market_size_companies,
    ],
    ["Test budget", <Fig key="j" f={c.test.budget_gbp} />, c.test.budget_gbp],
    ["Weekly sends", <Fig key="k" f={c.test.weekly_volume} money={false} />, c.test.weekly_volume],
    [
      "Days to first £",
      <Fig key="l" f={c.test.days_to_first_gbp} money={false} unit=" days" />,
      c.test.days_to_first_gbp,
    ],
  ];
  return (
    <table>
      <tbody>
        {rows.map(([k, v, f]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>
              {v}
              {f.assumption && <div className="muted small">{f.assumption}</div>}
            </td>
          </tr>
        ))}
        <tr>
          <td>Sample size and time cap</td>
          <td>
            {c.test.sample_size} sends in {c.test.time_cap_days} days
          </td>
        </tr>
        <tr>
          <td>Kill criteria</td>
          <td>
            {c.kill_criteria
              .map(
                (k) =>
                  `${k.metric.replaceAll("_", " ")} ${k.op} ${k.threshold} from day ${k.by_day}`,
              )
              .join("; ")}
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function Actions({ row, onDone }: { row: FeedRow; onDone: (m: string) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const d = row.decision;
  if (!d) return <p className="muted">No decision open ({row.status}).</p>;
  const choose = async (option: string) => {
    if (option === "fail" && !reason.trim())
      return onDone("Say why it fails: the planner reads your reason.");
    setBusy(true);
    const r = await fetch(`/api/decisions/${d.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option, ...(option === "fail" ? { reason } : {}) }),
    });
    setBusy(false);
    onDone(r.ok ? `Done: ${option}` : ((await r.json()).error ?? `HTTP ${r.status}`));
  };
  return (
    <div>
      {row.legal_check_needed && (
        <p className="banner">
          A regulated introduction: complete the legal check below before it can pass.
        </p>
      )}
      <input
        type="text"
        placeholder="Reason (needed to fail)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{ width: "100%", maxWidth: 480 }}
      />
      <div className="decision-options">
        {d.options.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={busy}
            className={o.key === d.recommended ? "primary" : undefined}
            title={o.effect}
            onClick={() => choose(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CardView({ id }: { id: string }) {
  const [data, setData] = useState<{
    versions: { card: Card; status: string }[];
    thread: ThreadRow[];
  } | null>(null);
  const [feedRow, setFeedRow] = useState<FeedRow | null>(null);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ versions: { card: Card; status: string }[]; thread: ThreadRow[] }>(
      `/api/ideas/${id}`,
    ).then(setData, (e: Error) => setMsg(e.message));
    getJson<{ cards: FeedRow[] }>("/api/ideas").then(
      (r) => setFeedRow(r.cards.find((x) => x.card.card_id === id) ?? null),
      () => {},
    );
  }, [id]);
  useEffect(load, [load]);
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`/api/ideas/${id}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setMsg(r.ok ? "Saved" : ((await r.json()).error ?? `HTTP ${r.status}`));
    setText("");
    load();
  };
  if (!data) return <p className="muted">{msg ?? "Loading…"}</p>;
  const latest = data.versions.at(-1) as { card: Card; status: string };
  const c = latest.card;
  return (
    <div>
      <p>
        <a href="#/ideas">← Ideas</a>
      </p>
      <h2>
        {c.offer}{" "}
        <small className="muted">
          v{c.version} · {latest.status}
        </small>
      </h2>
      <p>{c.thesis}</p>
      <p className="muted">
        {c.market.buyer}
        {c.market.industry ? ` · ${c.market.industry}` : ""} · function {c.taxonomy_node} · route{" "}
        {c.route.replace("_", " ")} · lane {c.lane}
        {c.what_changed ? ` · what changed: ${c.what_changed}` : ""}
      </p>
      {msg && <p className="muted">{msg}</p>}
      <p className="small">
        Plan: {feedRow?.plan_status ?? "not planned yet"}
        {feedRow && feedRow.plan_status !== "not planned yet" && (
          <>
            {" "}
            · <a href={`#/plans/plan-${c.card_id.replace(/^card-/, "")}`}>open the plan</a>
          </>
        )}
      </p>
      {feedRow && (
        <Actions
          row={feedRow}
          onDone={(m) => {
            setMsg(m);
            load();
          }}
        />
      )}
      <h3>Economics</h3>
      <Economics c={c} />
      <h3>Evidence</h3>
      <p className="muted small">
        Signals: {c.evidence.signal_ids.join(", ") || "none"} · Facts:{" "}
        {c.evidence.fact_ids.join(", ") || "none"}
      </p>
      <h3>Thread</h3>
      {data.thread.length === 0 && <p className="muted">No questions yet.</p>}
      {data.thread.map((t) => (
        <div key={t.id} className="card">
          <b>{t.author}</b> <span className="kind">{t.kind}</span>{" "}
          <small className="muted">v{t.version}</small>
          <p style={{ margin: "0.3rem 0" }}>{t.text}</p>
          {t.evidence.length > 0 && (
            <small className="muted">Evidence: {t.evidence.join(", ")}</small>
          )}
        </div>
      ))}
      <textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask the planner a question, or leave a comment"
        style={{ width: "100%" }}
      />
      <div className="decision-options">
        <button type="button" disabled={!text.trim()} onClick={() => post("question", { text })}>
          Ask a question
        </button>
        <button type="button" disabled={!text.trim()} onClick={() => post("comment", { text })}>
          Comment
        </button>
        {c.regulated && c.route === "sell_intro" && !c.legal_check && (
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => post("legal-check", { note: text })}
          >
            Record legal check
          </button>
        )}
      </div>
      {data.versions.length > 1 && (
        <p className="muted small">
          Earlier versions:{" "}
          {data.versions
            .slice(0, -1)
            .map((v) => `v${v.card.version} (${v.status})`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

/** The Ideas feed: cards ranked by expected profit per hour of your time (v3 Phase 6). */
export function Ideas({ route }: { route: string }) {
  const id = route.startsWith("/ideas/") ? route.slice(7) : null;
  const [data, setData] = useState<{
    cards: FeedRow[];
    held_back: { card_id: string; status: string; reason: string | null }[];
    filters: { functions: string[]; markets: string[] };
  } | null>(null);
  const [fn, setFn] = useState("");
  const [market, setMarket] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (id) return;
    const q = new URLSearchParams({
      ...(fn ? { function: fn } : {}),
      ...(market ? { market } : {}),
    });
    getJson<typeof data>(`/api/ideas?${q}`).then(setData, (e: Error) => setMsg(e.message));
  }, [id, fn, market]);
  if (id) return <CardView id={id} />;
  return (
    <div>
      <h2>Ideas</h2>
      <div className="filters">
        <select value={fn} onChange={(e) => setFn(e.target.value)} aria-label="Function">
          <option value="">Every function</option>
          {data?.filters.functions.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
          <option value="">Every market</option>
          {data?.filters.markets.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {data && data.cards.length === 0 && (
        <p className="empty">
          No idea cards yet. Scouts raise signals; the planner turns them into cards here.
        </p>
      )}
      {data?.cards.map((r) => (
        <div key={r.card.card_id} className="card">
          <div className="decision-head">
            <a href={`#/ideas/${r.card.card_id}`}>
              <b>{r.card.offer}</b>
            </a>
            <span className="kind">{r.status}</span>
            {r.synthetic && <span className="kind kind-synthetic">synthetic</span>}
          </div>
          <p className="muted" style={{ margin: "0.2rem 0" }}>
            {r.card.market.buyer}
            {r.card.market.industry ? ` · ${r.card.market.industry}` : ""} · {r.card.taxonomy_node}{" "}
            · plan: {r.plan_status}
          </p>
          <p style={{ margin: "0.2rem 0" }}>
            <Fig f={r.card.economics.profit_per_owner_hour} /> per hour of your time · test{" "}
            <Fig f={r.card.test.budget_gbp} />
          </p>
        </div>
      ))}
      {data && data.held_back.length > 0 && (
        <details>
          <summary className="muted">{data.held_back.length} held back before reaching you</summary>
          {data.held_back.map((h) => (
            <p key={`${h.card_id}-${h.status}`} className="muted small">
              {h.card_id}: {h.status.replaceAll("_", " ")} ({h.reason})
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
