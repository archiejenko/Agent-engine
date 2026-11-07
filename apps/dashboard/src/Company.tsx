import { useEffect, useState } from "react";
import { type Claim, day, type Fact, getJson, short } from "./api.ts";

interface CompanyData {
  entity: {
    entity_id: string;
    name: string;
    postcode: string | null;
    lad_code: string | null;
    sic_codes: string[];
  } | null;
  facts: Fact[];
  claims: Record<string, Claim>;
}

/** One company: every fact with the claims and evidence behind it, side by side. */
export function Company({ id }: { id: string }) {
  const [data, setData] = useState<CompanyData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    getJson<CompanyData>(`/api/companies/${id}`)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [id]);
  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!data) return <p>Loading…</p>;
  return (
    <>
      <h2>
        {data.entity?.name ?? id} <small style={{ color: "#666" }}>{id}</small>
      </h2>
      {data.entity && (
        <p>
          {data.entity.postcode} · {data.entity.lad_code} · SIC{" "}
          {data.entity.sic_codes.join(", ") || "none"}
        </p>
      )}
      <table
        cellPadding={4}
        style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.9rem" }}
      >
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
            <th>Field</th>
            <th>Value</th>
            <th>Conf.</th>
            <th>Status</th>
            <th>Lane</th>
            <th>Known from</th>
            <th>Expires</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {data.facts.map((f) => (
            <FactRow
              key={f.field}
              f={f}
              claims={data.claims}
              open={open === f.field}
              toggle={() => setOpen(open === f.field ? null : f.field)}
            />
          ))}
        </tbody>
      </table>
    </>
  );
}

function FactRow({
  f,
  claims,
  open,
  toggle,
}: {
  f: Fact;
  claims: Record<string, Claim>;
  open: boolean;
  toggle: () => void;
}) {
  const list = [
    ...f.supporting_claims.map((id) => ({ id, role: "supports" })),
    ...f.conflicting_claims.map((id) => ({ id, role: "conflicts" })),
  ];
  return (
    <>
      <tr
        style={{
          borderBottom: "1px solid #eee",
          background: f.status === "conflict" ? "#fff4e5" : undefined,
        }}
      >
        <td>{f.field}</td>
        <td>{short(f.value)}</td>
        <td>{f.confidence.toFixed(2)}</td>
        <td>{f.status}</td>
        <td>{f.lane}</td>
        <td>{day(f.valid_from)}</td>
        <td>{day(f.expires_at)}</td>
        <td>
          <button type="button" onClick={toggle}>
            {open ? "hide" : `${list.length} claim(s)`}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ background: "#f7f7f7" }}>
            {list.map(({ id, role }) => {
              const c = claims[id];
              return (
                <div key={id} style={{ marginBottom: "0.5rem", fontSize: "0.85rem" }}>
                  <b>{role}</b> · {c?.source} (tier {c?.source_tier}, {c?.method}) · published{" "}
                  {day(c?.published_at ?? null)} · fetched {day(c?.fetched_at ?? null)}
                  <div>
                    value: <code>{short(c?.value, 400)}</code>
                  </div>
                  <div>
                    evidence: <code>{c?.evidence?.ref}</code>
                    {c?.evidence?.text && <q>{c.evidence.text}</q>}
                  </div>
                  <div style={{ color: "#888" }}>
                    claim {id} · run {c?.run_id}
                  </div>
                </div>
              );
            })}
          </td>
        </tr>
      )}
    </>
  );
}
