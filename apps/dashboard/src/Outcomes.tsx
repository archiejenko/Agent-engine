import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";

interface EventLift {
  event: string;
  ranked: { companies: number; rate: number };
  holdout: { companies: number; rate: number };
  lift: number | null;
  ci95: [number, number] | null;
  better_than_holdout: boolean;
}
interface LiftData {
  label: string;
  cohorts: number;
  arms: Record<"ranked" | "holdout", { assigned: number; rejected_drafts: number }>;
  events: EventLift[];
  supported_by_paid: boolean;
  note: string;
}
interface EconRow {
  key: string;
  tasks: number;
  model_cost_gbp: number;
  send_cost_gbp: number;
  revenue_gbp: number;
  margin_gbp: number;
  human_minutes: number;
}
interface EconData {
  label: string;
  days: number;
  by_playbook: EconRow[];
  by_experiment: EconRow[];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const LABELS: Record<string, string> = {
  sent: "Sent",
  qr_scan: "Scanned the QR code",
  demo_visit: "Opened the demo page",
  reply: "Replied",
  reply_positive: "Replied (not an opt-out)",
  booking: "Booked a call",
  paid: "Paid",
};

/**
 * v2 Phase 1: did ranking beat random? (lift against the holdout, measured on assignment) and what each
 * playbook costs, earns and takes of Archie's time. Real rows only, unless "include simulated" is on.
 */
export function Outcomes() {
  const [sim, setSim] = useState(false);
  const [lift, setLift] = useState<LiftData | null>(null);
  const [econ, setEcon] = useState<EconData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = sim ? "?synthetic=1" : "";
    Promise.all([
      getJson<LiftData>(`/api/lift${q}`),
      getJson<EconData>(`/api/economics${q}${q ? "&" : "?"}days=30`),
    ])
      .then(([l, e]) => {
        setLift(l);
        setEcon(e);
      })
      .catch((e: Error) => setError(e.message));
  }, [sim]);
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!lift || !econ) return <p>Loading…</p>;
  return (
    <>
      <h2>Ranked leads against a random holdout</h2>
      <p>
        <label>
          <input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} /> Include
          simulated rows
        </label>
        {lift.label !== "real" && <b style={{ marginLeft: 8, color: "#a15c00" }}>{lift.label}</b>}
      </p>
      <p>
        {lift.cohorts} cohort(s). Ranked: {lift.arms.ranked.assigned} companies assigned (
        {lift.arms.ranked.rejected_drafts} drafts you rejected). Holdout:{" "}
        {lift.arms.holdout.assigned} assigned ({lift.arms.holdout.rejected_drafts} rejected). Rates
        count every assigned company, approved or not.
      </p>
      <table>
        <thead>
          <tr>
            <th align="left">Step</th>
            <th>Ranked</th>
            <th>Holdout</th>
            <th>Lift</th>
            <th>95% range</th>
          </tr>
        </thead>
        <tbody>
          {lift.arms.ranked.assigned + lift.arms.holdout.assigned === 0 && (
            <EmptyRow cols={5}>
              No cohorts yet: they start when you approve outreach leads.
            </EmptyRow>
          )}
          {lift.arms.ranked.assigned + lift.arms.holdout.assigned > 0 &&
            lift.events.map((e) => (
              <tr key={e.event}>
                <td>{LABELS[e.event] ?? e.event}</td>
                <td align="right">
                  {e.ranked.companies} ({pct(e.ranked.rate)})
                </td>
                <td align="right">
                  {e.holdout.companies} ({pct(e.holdout.rate)})
                </td>
                <td align="right">{e.lift === null ? "–" : `${e.lift.toFixed(2)}×`}</td>
                <td align="right">
                  {e.ci95 ? `${e.ci95[0].toFixed(2)}–${e.ci95[1].toFixed(2)}` : "–"}
                  {e.better_than_holdout && " ✓"}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
      <p className={lift.supported_by_paid ? "" : "empty"}>{lift.note}</p>

      <h2>Unit economics ({econ.days} days)</h2>
      {econ.label !== "real" && <b style={{ color: "#a15c00" }}>{econ.label}</b>}
      <table>
        <thead>
          <tr>
            <th align="left">Playbook</th>
            <th>Tasks</th>
            <th>Model £</th>
            <th>Sending £</th>
            <th>Revenue £</th>
            <th>Margin £</th>
            <th>Your minutes</th>
          </tr>
        </thead>
        <tbody>
          {econ.by_playbook.length === 0 && <EmptyRow cols={7}>No tasks in this period.</EmptyRow>}
          {econ.by_playbook.map((r) => (
            <tr key={r.key}>
              <td>{r.key}</td>
              <td align="right">{r.tasks}</td>
              <td align="right">{r.model_cost_gbp.toFixed(2)}</td>
              <td align="right">{r.send_cost_gbp.toFixed(2)}</td>
              <td align="right">{r.revenue_gbp.toFixed(2)}</td>
              <td align="right">{r.margin_gbp.toFixed(2)}</td>
              <td align="right">{r.human_minutes.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
