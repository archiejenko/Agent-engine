import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow, label } from "./format.tsx";

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

interface Today {
  drafts_waiting: number;
  letters_awaiting_batch_approval: number;
  letters_waiting_for_next_batch: number;
  pending_batches: number;
  open_conflicts: number;
  open_alerts: number;
  last_7_days: { revenue_gbp: number; cost_gbp: number; margin_gbp: number };
}

const gbp = (x: number) =>
  `${x < 0 ? "−" : ""}£${Math.abs(x).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What needs Archie today, and the last 7 days' money. Each tile links to where you act on it. */
function TodayPanel({ t }: { t: Today }) {
  const tiles: { label: string; value: string; note?: string; href: string; attention: boolean }[] =
    [
      {
        label: "Drafts waiting",
        value: String(t.drafts_waiting),
        href: "#/review",
        attention: t.drafts_waiting > 0,
      },
      {
        label: "Letters awaiting batch approval",
        value: String(t.letters_awaiting_batch_approval),
        note: t.letters_waiting_for_next_batch
          ? `+${t.letters_waiting_for_next_batch} for the next batch`
          : undefined,
        href: "#/letters",
        attention: t.letters_awaiting_batch_approval > 0,
      },
      {
        label: "Open conflicts",
        value: String(t.open_conflicts),
        href: "#/review",
        attention: t.open_conflicts > 0,
      },
      {
        label: "Alerts",
        value: String(t.open_alerts),
        href: "#/controls",
        attention: t.open_alerts > 0,
      },
      {
        label: "Revenue (7 days)",
        value: gbp(t.last_7_days.revenue_gbp),
        href: "#/metrics",
        attention: false,
      },
      {
        label: "Cost (7 days)",
        value: gbp(t.last_7_days.cost_gbp),
        href: "#/metrics",
        attention: false,
      },
      {
        label: "Margin (7 days)",
        value: gbp(t.last_7_days.margin_gbp),
        href: "#/metrics",
        attention: t.last_7_days.margin_gbp < 0,
      },
    ];
  return (
    <section aria-labelledby="today">
      <h2 id="today">Today</h2>
      <div className="tiles">
        {tiles.map((x) => (
          <a key={x.label} href={x.href} className={`tile${x.attention ? " attention" : ""}`}>
            <span className="tile-value">{x.value}</span>
            <span className="tile-label">{x.label}</span>
            {x.note && <span className="tile-note">{x.note}</span>}
          </a>
        ))}
      </div>
    </section>
  );
}

export function Overview() {
  const [health, setHealth] = useState<Health | null>(null);
  const [data, setData] = useState<OverviewData | null>(null);
  const [today, setToday] = useState<Today | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getJson<Health>("/api/health")
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
    getJson<Today>("/api/today")
      .then(setToday)
      .catch((e: Error) => setError(e.message));
    getJson<OverviewData>("/api/overview")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <p style={{ color: "crimson" }}>Unavailable: {error}</p>;
  if (!health || !data || !today) return <p>Loading…</p>;
  const n = (x: number) => x.toLocaleString("en-GB");
  return (
    <>
      <TodayPanel t={today} />
      <h2>Data</h2>
      <p>
        API <b>{health.status}</b> ({health.runtime}, v{health.version}) · database{" "}
        {health.storage.ok ? "ok" : "error"} · {health.storage.migrations} migrations
      </p>
      <h3>Universe: {data.universe.region}</h3>
      <p>
        <b>{n(data.universe.included)}</b> companies included ({n(data.universe.staff_unknown)} with
        unknown staff numbers) · {n(data.universe.excluded)} excluded · {n(data.counts.entities)}{" "}
        companies in the anchor registry
      </p>
      <Table
        rows={data.universe.reasons}
        label="Decision"
        empty="No companies assessed yet: run the universe step first."
      />
      <h3>Verified facts</h3>
      <Table rows={data.facts} label="Status" empty="No verified facts yet." />
      <p>
        {n(data.counts.claims)} claims · {n(data.counts.observations)} observations
      </p>
      <h3>Claims rejected by sanity rules</h3>
      {Object.keys(data.counts.rejections).length ? (
        <Table rows={data.counts.rejections} label="Rule" empty="None." />
      ) : (
        <p>None.</p>
      )}
    </>
  );
}

function Table({
  rows,
  label: head,
  empty,
}: {
  rows: Record<string, number>;
  label: string;
  empty?: string;
}) {
  const entries = Object.entries(rows);
  return (
    <table>
      <thead>
        <tr>
          <th>{head}</th>
          <th className="num">Count</th>
        </tr>
      </thead>
      <tbody>
        {entries.length === 0 && <EmptyRow cols={2}>{empty ?? "Nothing yet."}</EmptyRow>}
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td>{label(k)}</td>
            <td className="num">{v.toLocaleString("en-GB")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
