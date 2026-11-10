import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";

interface ControlsData {
  kill_global: boolean;
  queue_paused: boolean;
  caps: { global_per_day_gbp: number; per_playbook_per_day_gbp: Record<string, number> };
  playbooks: {
    playbook: string;
    autonomy: string;
    killed: boolean;
    tasks: number;
    success_rate: number;
    approved_without_edit: number;
    breaches: number;
    cost_gbp: number;
    revenue_gbp: number;
  }[];
  alerts: { id: number; kind: string; message: string; created_at: string }[];
  outbox: {
    id: string;
    recipient: string;
    subject: string;
    status: string;
    reason: string | null;
    created_at: string;
  }[];
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
  });
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

/** Kill switches, caps, queue, autonomy (promotion is your click), alerts and the outbox. */
export function Controls() {
  const [d, setD] = useState<ControlsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<ControlsData>("/api/controls")
      .then(setD)
      .catch((e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);
  const act = (p: Promise<unknown>) => p.then(load).catch((e: Error) => setMsg(e.message));
  if (!d) return <p>{msg ?? "Loading…"}</p>;
  const rate = (p: ControlsData["playbooks"][0], x: number) => (p.tasks === 0 ? "—" : pct(x));
  return (
    <>
      {msg && <p style={{ color: "crimson" }}>{msg}</p>}
      <div className={`banner ${d.kill_global ? "off" : "live"}`} role="status">
        <div>
          {d.kill_global ? "Sending: OFF, dry run" : "Sending: LIVE"}
          <small>
            {d.kill_global
              ? "Nothing leaves the system: emails go to the outbox, payments to the fake ledger, alerts to a log."
              : "External actions are allowed, for every playbook whose own switch below is also on."}
          </small>
        </div>
        <button
          type="button"
          className={d.kill_global ? "primary" : undefined}
          onClick={() => act(post("/api/controls/kill", { scope: "global", on: !d.kill_global }))}
        >
          {d.kill_global ? "Go live (allow sending)" : "Stop all sending"}
        </button>
      </div>
      <p>
        Task queue: <b>{d.queue_paused ? "paused" : "running"}</b>{" "}
        <button
          type="button"
          onClick={() => act(post("/api/controls/queue", { paused: !d.queue_paused }))}
        >
          {d.queue_paused ? "Resume" : "Pause"}
        </button>
        {" · "}Spend caps: £{d.caps.global_per_day_gbp}/day overall;{" "}
        {Object.entries(d.caps.per_playbook_per_day_gbp)
          .map(([k, v]) => `${k} £${v}`)
          .join(", ")}
      </p>
      <h2>Playbooks and autonomy</h2>
      <table>
        <thead>
          <tr>
            <th>Playbook</th>
            <th>Own switch</th>
            <th>Level</th>
            <th className="num">Last tasks</th>
            <th className="num">Success</th>
            <th className="num">No-edit approvals</th>
            <th className="num">Breaches</th>
            <th className="num">Cost £</th>
            <th className="num">Revenue £</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {d.playbooks.map((p) => (
            <tr key={p.playbook}>
              <td>{p.playbook}</td>
              <td>
                <span className={`pill ${p.killed ? "off" : "on"}`}>
                  {p.killed ? "Stopped" : d.kill_global ? "On (dry run)" : "On"}
                </span>
              </td>
              <td>{p.autonomy}</td>
              <td className="num">{p.tasks}</td>
              <td className="num">{rate(p, p.success_rate)}</td>
              <td className="num">
                {p.autonomy === "L3" ? "n/a (automatic)" : rate(p, p.approved_without_edit)}
              </td>
              <td className="num">{p.breaches}</td>
              <td className="num">{p.cost_gbp.toFixed(2)}</td>
              <td className="num">{p.revenue_gbp.toFixed(2)}</td>
              <td className="nowrap">
                <button
                  type="button"
                  onClick={() =>
                    act(
                      post("/api/controls/kill", {
                        scope: { playbook: p.playbook },
                        on: !p.killed,
                      }),
                    )
                  }
                >
                  {p.killed ? "Turn on" : "Stop"}
                </button>{" "}
                {p.autonomy !== "L3" && (
                  <button
                    type="button"
                    onClick={() => act(post(`/api/playbooks/${p.playbook}/promote`, {}))}
                  >
                    Promote
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        A playbook acts for real only when sending is live <b>and</b> its own switch is on.
        Promotion needs ≥ 90% success, ≥ 80% approved without edits and zero breaches over the last
        50 tasks. Any breach drops the playbook a level automatically. L3 is the top level.
      </p>
      <h2>Alerts</h2>
      {d.alerts.length === 0 ? (
        <p className="empty">No open alerts.</p>
      ) : (
        d.alerts.map((a) => (
          <p key={a.id}>
            <b>{a.kind.replace(/_/g, " ")}</b> {a.message}{" "}
            <button type="button" onClick={() => act(post(`/api/alerts/${a.id}/ack`, {}))}>
              OK
            </button>
          </p>
        ))
      )}
      <h2>Outbox (latest)</h2>
      <table style={{ fontSize: "0.85rem", width: "100%" }}>
        <thead>
          <tr>
            <th>When</th>
            <th>To</th>
            <th>Subject</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {d.outbox.length === 0 && (
            <EmptyRow cols={5}>Nothing sent yet (dry runs are listed here too).</EmptyRow>
          )}
          {d.outbox.map((m) => (
            <tr key={m.id}>
              <td className="nowrap">{m.created_at.slice(0, 16).replace("T", " ")}</td>
              <td>{m.recipient}</td>
              <td>{m.subject}</td>
              <td>{m.status.replace("_", " ")}</td>
              <td>{m.reason ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
