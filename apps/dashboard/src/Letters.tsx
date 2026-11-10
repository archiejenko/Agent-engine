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
  blocked_duplicates: { id: number; message: string; created_at: string }[];
  cooldown_days: number;
  legal_placeholders: boolean;
  cost_per_letter_gbp: number;
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
      {data.legal_placeholders && (
        <p
          role="alert"
          style={{ background: "#fdecea", border: "1px solid #f5c2c0", padding: "0.6rem" }}
        >
          <strong>Don't print yet:</strong> EJTECH's company number and registered office are still
          placeholders in the settings, and every letter prints them in its footer.
        </p>
      )}
      {data.blocked_duplicates.length > 0 && (
        <div
          role="alert"
          style={{
            background: "#fdecea",
            border: "1px solid #f5c2c0",
            padding: "0.6rem",
            margin: "0.6rem 0",
          }}
        >
          <strong>
            {data.blocked_duplicates.length} duplicate
            {data.blocked_duplicates.length === 1 ? "" : "s"} blocked
          </strong>{" "}
          (one contact per company every {data.cooldown_days} days, across email and letters):
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
            {data.blocked_duplicates.slice(0, 10).map((b) => (
              <li key={b.id}>{b.message}</li>
            ))}
          </ul>
          {data.blocked_duplicates.length > 10 && (
            <p>…and {data.blocked_duplicates.length - 10} more (see Controls → Alerts).</p>
          )}
        </div>
      )}
      <p>
        {data.waiting.length === 0
          ? "No letters waiting for the next weekly batch."
          : `${data.waiting.length} ${data.waiting.length === 1 ? "letter" : "letters"} waiting for the next weekly batch.`}{" "}
        {data.waiting.length > 0 && (
          <button
            type="button"
            onClick={() => post("/api/letters/batches", {}).then(load, (e) => setMsg(String(e)))}
          >
            Make a batch now
          </button>
        )}
      </p>
      {data.batches.length === 0 && (
        <p className="empty">
          No print batches yet: approved leads without an email address become letters here.
        </p>
      )}
      {data.batches.map((b) => (
        <div key={b.id} style={{ borderTop: "1px solid #ddd", marginTop: "1rem" }}>
          <h3>
            {b.week}: {b.letter_count} letters, {b.flagged_count} flagged ({b.status}) · print and
            post about £{(b.letter_count * data.cost_per_letter_gbp).toFixed(2)}{" "}
            <a href={`/api/letters/batches/${b.id}/pdf`}>Download PDF</a>
          </h3>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {b === pending && <th>Leave out</th>}
                <th align="left">Company</th>
                <th align="left">Addressed to</th>
                <th align="left">Flags</th>
                <th align="left">Demo (live once approved and sending is on)</th>
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
              <button type="button" className="primary" onClick={() => decide(b, "approve")}>
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
