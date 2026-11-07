import { useCallback, useEffect, useState } from "react";
import { type Fact, getJson, short } from "./api.ts";

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
  if (!n.entity) return <p>Golden set complete ({n.done} companies).</p>;
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
      <p>
        <b>{n.entity.name}</b> {n.entity.entity_id} · {n.entity.postcode}. Check each value at the
        source and type the true value (leave blank to skip).
      </p>
      <table cellPadding={4}>
        <tbody>
          {n.fields.map((f) => {
            const fact = n.facts.find((x) => x.field === f);
            return (
              <tr key={f}>
                <td>{f}</td>
                <td style={{ color: "#666" }}>
                  {fact
                    ? `${short(fact.value, 60)} (confidence ${fact.confidence.toFixed(2)})`
                    : "no fact"}
                </td>
                <td>
                  <input
                    value={values[f] ?? ""}
                    placeholder={fact ? String(fact.value) : ""}
                    onChange={(e) => setValues({ ...values, [f]: e.target.value })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" onClick={save}>
        Save and next
      </button>{" "}
      <button type="button" onClick={load}>
        Skip
      </button>
    </>
  );
}
