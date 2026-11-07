import { useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface MetricsData {
  verification: {
    golden_companies: number;
    accuracy: { source: string; field: string; n: number; correct: number; accuracy: number }[];
    calibration: {
      field: string;
      bucket: string;
      n: number;
      mean_confidence: number;
      accuracy: number;
    }[];
    brier: number | null;
  };
  facts: Record<string, number>;
  pauses: { source: string; field: string; reason: string; paused_at: string }[];
  drift_today: {
    source: string;
    field: string;
    volume: number;
    null_rate: number;
    match_rate: number;
  }[];
  backtests: {
    module: string;
    as_of: string;
    mode: string;
    precision_at_20: number;
    base_rate: number;
    lift: number;
    revenue_lift: number | null;
  }[];
  margins_7d: {
    playbook: string;
    tasks: number;
    cost_gbp: number;
    revenue_gbp: number;
    margin_gbp: number;
  }[];
  alerts: { id: number; kind: string; message: string; created_at: string }[];
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function Metrics() {
  const [d, setD] = useState<MetricsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<MetricsData>("/api/metrics")
      .then(setD)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!d) return <p>Loading…</p>;
  const resume = (source: string, field: string) =>
    fetch("/api/pauses/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, field }),
    }).then(() => location.reload());
  return (
    <>
      {d.alerts.length > 0 && (
        <>
          <h2>Alerts</h2>
          {d.alerts.map((a) => (
            <p key={a.id}>
              <b>{a.kind}</b> {a.message} <small>{a.created_at.slice(0, 16)}</small>
            </p>
          ))}
        </>
      )}
      <h2>
        Verification accuracy (against your golden set: {d.verification.golden_companies} companies)
      </h2>
      <table cellPadding={4}>
        <thead>
          <tr>
            <th align="left">Source</th>
            <th align="left">Field</th>
            <th>Checked</th>
            <th>Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {d.verification.accuracy.map((a) => (
            <tr key={`${a.source}.${a.field}`}>
              <td>{a.source}</td>
              <td>{a.field}</td>
              <td align="right">{a.n}</td>
              <td align="right">{pct(a.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>
        Calibration (does confidence match reality?){" "}
        {d.verification.brier !== null && (
          <small>Brier {d.verification.brier.toFixed(3)} (lower is better)</small>
        )}
      </h3>
      <table cellPadding={4}>
        <thead>
          <tr>
            <th align="left">Field</th>
            <th>Confidence band</th>
            <th>Facts</th>
            <th>Avg confidence</th>
            <th>Actually right</th>
          </tr>
        </thead>
        <tbody>
          {d.verification.calibration.map((b) => (
            <tr key={`${b.field}.${b.bucket}`}>
              <td>{b.field}</td>
              <td>{b.bucket}</td>
              <td align="right">{b.n}</td>
              <td align="right">{pct(b.mean_confidence)}</td>
              <td align="right">{pct(b.accuracy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Paused sources (drift)</h2>
      {d.pauses.length === 0 ? (
        <p>None.</p>
      ) : (
        d.pauses.map((p) => (
          <p key={`${p.source}.${p.field}`}>
            {p.source}.{p.field}: {p.reason}{" "}
            <button type="button" onClick={() => resume(p.source, p.field)}>
              Resume
            </button>
          </p>
        ))
      )}
      <h2>Module backtests</h2>
      {d.backtests.map((b) => (
        <p key={b.module}>
          {b.module} as of {b.as_of} ({b.mode}): precision@20 {pct(b.precision_at_20)}, base rate{" "}
          {pct(b.base_rate)}, <b>lift {b.lift.toFixed(2)}×</b>
          {b.revenue_lift !== null && <>, revenue lift {b.revenue_lift.toFixed(2)}×</>}
        </p>
      ))}
      <h2>Playbook margins (7 days)</h2>
      <table cellPadding={4}>
        <thead>
          <tr>
            <th align="left">Playbook</th>
            <th>Tasks</th>
            <th>Cost £</th>
            <th>Revenue £</th>
            <th>Margin £</th>
          </tr>
        </thead>
        <tbody>
          {d.margins_7d.map((m) => (
            <tr key={m.playbook}>
              <td>{m.playbook}</td>
              <td align="right">{m.tasks}</td>
              <td align="right">{m.cost_gbp.toFixed(2)}</td>
              <td align="right">{m.revenue_gbp.toFixed(2)}</td>
              <td align="right">{m.margin_gbp.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
