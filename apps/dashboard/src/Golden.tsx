import { useCallback, useEffect, useState } from "react";
import { type Fact, getJson } from "./api.ts";
import { FactValue, label } from "./format.tsx";

interface Next {
  entity: { entity_id: string; name: string; postcode: string | null } | null;
  fields: string[];
  facts: Fact[];
  done: number;
  target: number;
}

/** Hand-verify companies for the golden set: type what's actually true (from Companies House, the website, a call). */
export function Golden() {
  const [n, setN] = useState<Next | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    setValues({});
    getJson<Next>("/api/golden/next").then(setN);
  }, []);
  useEffect(load, [load]);
  if (!n) return <p>Loading…</p>;
  if (!n.entity)
    return n.done === 0 ? (
      <>
        <h2>Golden set</h2>
        <p className="empty">
          No companies verified yet, and none to check: the golden set starts once companies have
          been ingested.
        </p>
      </>
    ) : (
      <>
        <h2>Golden set</h2>
        <p>
          Golden set complete: {n.done} of {n.target} companies verified by hand.
        </p>
      </>
    );
  const save = async () => {
    const parsed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values))
      if (v.trim() !== "") parsed[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.trim();
    await fetch(`/api/golden/${n.entity?.entity_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: parsed }),
    });
    load();
  };
  return (
    <>
      <h2>
        Golden set: {n.done} of {n.target}
      </h2>
      {n.done === 0 && (
        <p>
          <b>No companies verified yet. Start with the first one</b> below: it takes a few minutes,
          and every company you check makes the accuracy figures on Metrics real.
        </p>
      )}
      <p>
        <b>{n.entity.name}</b> {n.entity.entity_id} · {n.entity.postcode}. Check each value at the
        source and type the true value (leave blank to skip).
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>What we hold</th>
            <th>True value (blank to skip)</th>
          </tr>
        </thead>
        <tbody>
          {n.fields.map((f) => {
            const fact = n.facts.find((x) => x.field === f);
            return (
              <tr key={f}>
                <td>{label(f)}</td>
                <td>
                  {fact ? (
                    <>
                      <FactValue field={f} value={fact.value} />{" "}
                      <span className="muted">(confidence {fact.confidence.toFixed(2)})</span>
                    </>
                  ) : (
                    <span className="muted">nothing held</span>
                  )}
                </td>
                <td>
                  <input
                    aria-label={`True value for ${label(f)}`}
                    value={values[f] ?? ""}
                    onChange={(e) => setValues({ ...values, [f]: e.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="primary" onClick={save}>
        Save and next
      </button>{" "}
      <button type="button" onClick={load}>
        Skip
      </button>
    </>
  );
}
