import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";

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
  return (
    <>
      {msg && <p style={{ color: "crimson" }}>{msg}</p>}
      <h2>Kill switch</h2>
      <p>
        External actions are{" "}
        <b style={{ color: d.kill_global ? "crimson" : "green" }}>
          {d.kill_global ? "OFF (kill switch ON — everything is a dry run)" : "ON"}
        </b>{" "}
        <button
          type="button"
          onClick={() => act(post("/api/controls/kill", { scope: "global", on: !d.kill_global }))}
        >
          {d.kill_global ? "Allow external actions" : "Stop all external actions"}
        </button>
      </p>
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
      <table cellPadding={4}>
        <thead>
          <tr>
            <th align="left">Playbook</th>
            <th>Level</th>
            <th>Last tasks</th>
            <th>Success</th>
            <th>No-edit approvals</th>
            <th>Breaches</th>
            <th>Cost £</th>
            <th>Revenue £</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {d.playbooks.map((p) => (
            <tr key={p.playbook}>
              <td>
                {p.playbook}
                {p.killed && " (stopped)"}
              </td>
              <td align="center">{p.autonomy}</td>
              <td align="right">{p.tasks}</td>
              <td align="right">{pct(p.success_rate)}</td>
              <td align="right">{pct(p.approved_without_edit)}</td>
              <td align="right">{p.breaches}</td>
              <td align="right">{p.cost_gbp.toFixed(2)}</td>
              <td align="right">{p.revenue_gbp.toFixed(2)}</td>
              <td>
                <button
                  type="button"
                  onClick={() => act(post(`/api/playbooks/${p.playbook}/promote`, {}))}
                >
                  Promote
                </button>{" "}
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
                  {p.killed ? "Restart" : "Stop"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: "0.85rem", color: "#666" }}>
        Promotion needs ≥ 90% success, ≥ 80% approved without edits and zero breaches over the last
        50 tasks. Any breach drops the playbook a level automatically.
      </p>
      <h2>Alerts</h2>
      {d.alerts.length === 0 ? (
        <p>None.</p>
      ) : (
        d.alerts.map((a) => (
          <p key={a.id}>
            <b>{a.kind}</b> {a.message}{" "}
            <button type="button" onClick={() => act(post(`/api/alerts/${a.id}/ack`, {}))}>
              OK
            </button>
          </p>
        ))
      )}
      <h2>Outbox (latest)</h2>
      <table cellPadding={4} style={{ fontSize: "0.85rem" }}>
        <tbody>
          {d.outbox.map((m) => (
            <tr key={m.id}>
              <td>{m.created_at.slice(0, 16)}</td>
              <td>{m.recipient}</td>
              <td>{m.subject}</td>
              <td>{m.status}</td>
              <td>{m.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
