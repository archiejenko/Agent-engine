import { useEffect, useState } from "react";
import { day, type Fact, getJson } from "./api.ts";
import { EmptyRow, FactValue, label } from "./format.tsx";

const PAGE = 50;

export function Facts() {
  const [search, setSearch] = useState("");
  const [field, setField] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: Fact[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (search) p.set("search", search);
    if (field) p.set("field", field);
    if (status) p.set("status", status);
    getJson<{ rows: Fact[]; total: number }>(`/api/facts?${p}`)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [search, field, status, offset]);

  return (
    <>
      <h2>Facts</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
        <input
          placeholder="Company name or number"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <input
          placeholder="Field (e.g. company_status)"
          value={field}
          onChange={(e) => {
            setField(e.target.value.trim());
            setOffset(0);
          }}
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">any status</option>
          <option>verified</option>
          <option>conflict</option>
          <option>stale</option>
          <option>quarantined</option>
        </select>
      </div>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {data && (
        <>
          <p>
            {data.total.toLocaleString("en-GB")} facts · showing {data.total ? offset + 1 : 0}–
            {Math.min(offset + PAGE, data.total)}{" "}
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              ‹ prev
            </button>{" "}
            <button
              type="button"
              disabled={offset + PAGE >= data.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              next ›
            </button>
          </p>
          <table style={{ width: "100%", fontSize: "0.9rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
                <th>Company</th>
                <th>Field</th>
                <th>Value</th>
                <th>Confidence</th>
                <th>Status</th>
                <th>Known from</th>
                <th>Last verified</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <EmptyRow cols={7}>
                  {search || field || status
                    ? "No facts match these filters."
                    : "No verified facts yet: run an ingestion first."}
                </EmptyRow>
              )}
              {data.rows.map((f) => (
                <tr key={`${f.entity_id}.${f.field}`} style={{ borderBottom: "1px solid #eee" }}>
                  <td>
                    <a href={`#/company/${f.entity_id}`}>{f.entity_id}</a>
                  </td>
                  <td>{label(f.field)}</td>
                  <td>
                    <FactValue field={f.field} value={f.value} max={2} />
                  </td>
                  <td className="num">{f.confidence.toFixed(2)}</td>
                  <td>{f.status}</td>
                  <td className="nowrap">{day(f.valid_from)}</td>
                  <td className="nowrap">{day(f.last_verified_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
