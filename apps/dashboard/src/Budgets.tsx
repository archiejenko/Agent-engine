import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface BudgetsData {
  global: { cap_gbp: number; spent_today_gbp: number };
  explore: { share: number; cap_gbp: number; spent_this_week_gbp: number };
  tiers: Record<"S1" | "S2" | "S3", number>;
  playbooks: { playbook: string; tier: string; cap_gbp: number; spent_today_gbp: number }[];
  refused_today: number;
}

const TIERS = ["S0", "S1", "S2", "S3"];
const gbp = (n: number) => `£${n.toFixed(2)}`;

/**
 * v2 hard budgets. Lowering a tier is one click. Raising one records your approval first (the only
 * way a budget can go up); agents can't do either.
 */
export function Budgets() {
  const [d, setD] = useState<BudgetsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<BudgetsData>("/api/budgets").then(setD, (e: Error) => setMsg(e.message));
  }, []);
  useEffect(load, [load]);
  if (!d) return <p>{msg ?? "Loading…"}</p>;
  const change = async (playbook: string, from: string, to: string) => {
    const up = TIERS.indexOf(to) > TIERS.indexOf(from);
    if (
      up &&
      !window.confirm(
        `Raise ${playbook} to ${to} (${gbp(d.tiers[to as "S1"])} a day)? This is recorded as your approval.`,
      )
    )
      return;
    const r = up
      ? await fetch("/api/owner-approvals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "spend_tier", playbook, tier: to }),
        })
      : await fetch(`/api/playbooks/${playbook}/spend-tier`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tier: to }),
        });
    setMsg(r.ok ? `${playbook} is now ${to}.` : ((await r.json()).error ?? `HTTP ${r.status}`));
    load();
  };
  return (
    <>
      <h2>Budgets</h2>
      <p>
        Today: {gbp(d.global.spent_today_gbp)} of {gbp(d.global.cap_gbp)} overall. Experiments this
        week: {gbp(d.explore.spent_this_week_gbp)} of {gbp(d.explore.cap_gbp)} (
        {(d.explore.share * 100).toFixed(0)}% of the week's budget).
        {d.refused_today > 0 && <b> {d.refused_today} step(s) refused today for lack of budget.</b>}
      </p>
      {msg && <p className="muted">{msg}</p>}
      <table>
        <thead>
          <tr>
            <th align="left">Playbook</th>
            <th>Spent today</th>
            <th>Daily cap</th>
            <th>Tier</th>
          </tr>
        </thead>
        <tbody>
          {d.playbooks.map((p) => (
            <tr key={p.playbook}>
              <td>{p.playbook}</td>
              <td align="right">{gbp(p.spent_today_gbp)}</td>
              <td align="right">{gbp(p.cap_gbp)}</td>
              <td align="right">
                <select value={p.tier} onChange={(e) => change(p.playbook, p.tier, e.target.value)}>
                  {TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
