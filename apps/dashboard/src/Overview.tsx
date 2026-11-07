import { useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface Health {
  status: string;
  runtime: string;
  version: string;
  storage: { ok: boolean; migrations: number };
}
interface OverviewData {
  universe: {
    name: string;
    region: string;
    included: number;
    excluded: number;
    staff_unknown: number;
    reasons: Record<string, number>;
  };
  facts: Record<string, number>;
  counts: {
    claims: number;
    observations: number;
    entities: number;
    rejections: Record<string, number>;
  };
}

export function Overview() {
  const [health, setHealth] = useState<Health | null>(null);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<Health>("/api/health")
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
    getJson<OverviewData>("/api/overview")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p style={{ color: "crimson" }}>Unavailable: {error}</p>;
  if (!health || !data) return <p>Loading…</p>;
  const n = (x: number) => x.toLocaleString("en-GB");
  return (
    <>
      <p>
        API <b>{health.status}</b> ({health.runtime}, v{health.version}) · database{" "}
        {health.storage.ok ? "ok" : "error"} · {health.storage.migrations} migrations
      </p>
      <h2>Universe: {data.universe.region}</h2>
      <p>
        <b>{n(data.universe.included)}</b> companies included ({n(data.universe.staff_unknown)} with
        unknown staff numbers) · {n(data.universe.excluded)} excluded · {n(data.counts.entities)}{" "}
        companies in the anchor registry
      </p>
      <Table rows={data.universe.reasons} label="Decision" />
      <h2>Verified facts</h2>
      <Table rows={data.facts} label="Status" />
      <p>
        {n(data.counts.claims)} claims · {n(data.counts.observations)} observations
      </p>
      <h3>Claims rejected by sanity rules</h3>
      {Object.keys(data.counts.rejections).length ? (
        <Table rows={data.counts.rejections} label="Rule" />
      ) : (
        <p>None.</p>
      )}
    </>
  );
}

function Table({ rows, label }: { rows: Record<string, number>; label: string }) {
  return (
    <table cellPadding={4}>
      <thead>
        <tr>
          <th align="left">{label}</th>
          <th align="right">Count</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(rows).map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td align="right">{v.toLocaleString("en-GB")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
