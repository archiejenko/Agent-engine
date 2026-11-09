import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface Letter {
  task_id: string;
  entity_id: string;
  company_name: string;
  address: string[];
  demo_url: string;
  flags: { flag: string; detail: string }[];
  status: string;
}
interface Batch {
  id: string;
  week: string;
  status: "pending" | "approved" | "rejected";
  letter_count: number;
  flagged_count: number;
  letters: Letter[];
}
interface LettersData {
  waiting: Letter[];
  batches: Batch[];
  known_bias: string;
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j as { note?: string };
  });

/** sme_letter print queue: approve the weekly batch (leave out flagged letters if you like), print it. */
export function Letters() {
  const [data, setData] = useState<LettersData | null>(null);
  const [exclude, setExclude] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<LettersData>("/api/letters").then(setData, (e) => setMsg(String(e)));
  }, []);
  useEffect(load, [load]);
  if (!data) return <p>{msg ?? "Loading…"}</p>;
  const pending = data.batches.find((b) => b.status === "pending");
  const decide = (b: Batch, decision: "approve" | "reject") =>
    post(`/api/letters/batches/${b.id}/decision`, { decision, exclude: [...exclude] }).then(
      (r) => {
        setMsg(`Batch ${decision}d. ${r.note ?? ""}`);
        setExclude(new Set());
        load();
      },
      (e) => setMsg(String(e)),
    );
  return (
    <section>
      <h2>Letters</h2>
      <p style={{ background: "#fff7d6", padding: "0.6rem" }}>
        <strong>Known bias:</strong> {data.known_bias}
      </p>
      {msg && <p>{msg}</p>}
      <p>
        {data.waiting.length} letter(s) waiting for the next weekly batch.{" "}
        {data.waiting.length > 0 && (
          <button
            type="button"
            onClick={() => post("/api/letters/batches", {}).then(load, (e) => setMsg(String(e)))}
          >
            Make a batch now
          </button>
        )}
      </p>
      {data.batches.map((b) => (
        <div key={b.id} style={{ borderTop: "1px solid #ddd", marginTop: "1rem" }}>
          <h3>
            {b.week}: {b.letter_count} letters, {b.flagged_count} flagged ({b.status}){" "}
            <a href={`/api/letters/batches/${b.id}/pdf`}>Download PDF</a>
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {b === pending && <th>Leave out</th>}
                <th align="left">Company</th>
                <th align="left">Addressed to</th>
                <th align="left">Flags</th>
                <th align="left">Demo</th>
              </tr>
            </thead>
            <tbody>
              {b.letters.map((l) => (
                <tr key={l.task_id} style={{ background: l.flags.length ? "#fdecea" : undefined }}>
                  {b === pending && (
                    <td>
                      <input
                        type="checkbox"
                        checked={exclude.has(l.task_id)}
                        onChange={(e) => {
                          const next = new Set(exclude);
                          if (e.target.checked) next.add(l.task_id);
                          else next.delete(l.task_id);
                          setExclude(next);
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <a href={`#/company/${l.entity_id}`}>{l.company_name}</a>
                  </td>
                  <td>{l.address.join(", ")}</td>
                  <td>{l.flags.map((f) => f.detail).join("; ") || "—"}</td>
                  <td>
                    <a href={l.demo_url} target="_blank" rel="noreferrer">
                      demo
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {b === pending && (
            <p>
              <button type="button" onClick={() => decide(b, "approve")}>
                Approve batch{exclude.size ? ` (leaving out ${exclude.size})` : ""}
              </button>{" "}
              <button type="button" onClick={() => decide(b, "reject")}>
                Reject batch
              </button>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
