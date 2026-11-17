import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";

interface RuntimeData {
  kill_switch_on: boolean;
  heartbeats: { name: string; at: string; minutes_ago: number | null }[];
  change_feed: { configured: boolean; polling_fallback_active: boolean };
  dead_letters: {
    id: string;
    body: { kind?: string };
    attempts: number;
    error: string | null;
    received_at: string;
  }[];
  uncertain_effects: {
    key: string;
    tool: string;
    task_id: string;
    status: string;
    started_at: string;
    error: string | null;
  }[];
  workflows: {
    counts: Record<string, number>;
    attention: {
      id: string;
      workflow: string;
      status: string;
      pause_reason: string | null;
      error: string | null;
    }[];
  };
  triggers_7d: {
    rule_id: string;
    seen: number;
    matched: number;
    acted: number;
    model_calls: number;
  }[];
}

const NAMES: Record<string, string> = {
  cron: "Scheduled trigger",
  tick: "Agent loop",
  queue_consumer: "Job queue",
  change_feed: "Companies House change feed",
  poll_fallback: "Polling fallback",
};

const _post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** v2 runtime health: is the loop running, is anything stuck, does anything need a person? */
export function Health() {
  const [d, setD] = useState<RuntimeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<RuntimeData>("/api/runtime").then(setD, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!d) return <p>Loading…</p>;
  return (
    <>
      <h2>Runtime health</h2>
      <p>
        Change feed: {d.change_feed.configured ? "connected" : "not connected yet"}
        {d.change_feed.polling_fallback_active && " · polling fallback is doing the work"}
        {d.kill_switch_on && " · kill switch ON (external actions are dry runs)"}
      </p>
      <table>
        <thead>
          <tr>
            <th align="left">Part</th>
            <th align="left">Last ran</th>
          </tr>
        </thead>
        <tbody>
          {d.heartbeats.length === 0 && <EmptyRow cols={2}>Nothing has run yet.</EmptyRow>}
          {d.heartbeats.map((h) => (
            <tr key={h.name}>
              <td>{NAMES[h.name] ?? h.name}</td>
              <td>
                {h.minutes_ago === null ? "never" : `${h.minutes_ago} min ago`}{" "}
                <small>{h.at.slice(0, 16)}</small>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Needs a person</h3>
      {d.dead_letters.length + d.uncertain_effects.length + d.workflows.attention.length === 0 && (
        <p className="empty">Nothing: no failed jobs, no uncertain actions, no stuck workflows.</p>
      )}
      {d.dead_letters.map((x) => (
        <p key={x.id} className="card">
          Failed job <b>{x.body?.kind ?? "job"}</b> ({x.attempts} attempts): {x.error}{" "}
          <a href="#/">In Needs you</a>
        </p>
      ))}
      {d.uncertain_effects.map((e) => (
        <p key={e.key} className="card">
          <b>{e.tool}</b> for task {e.task_id.slice(0, 8)} may or may not have happened (
          {e.error ?? e.status}). It won't be repeated until you say.{" "}
          <a href="#/">Decide in Needs you</a>
        </p>
      ))}
      {d.workflows.attention.map((w) => (
        <p key={w.id} className="card">
          Workflow <b>{w.workflow}</b> is {w.status}: {w.pause_reason ?? w.error}
        </p>
      ))}
      <h3>Triggers (7 days)</h3>
      <table>
        <thead>
          <tr>
            <th align="left">Rule</th>
            <th>Events seen</th>
            <th>Matched</th>
            <th>Model calls</th>
          </tr>
        </thead>
        <tbody>
          {d.triggers_7d.length === 0 && <EmptyRow cols={4}>No change events yet.</EmptyRow>}
          {d.triggers_7d.map((t) => (
            <tr key={t.rule_id}>
              <td>{t.rule_id.replace(/_/g, " ")}</td>
              <td align="right">{t.seen}</td>
              <td align="right">{t.matched}</td>
              <td align="right">{t.model_calls}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
