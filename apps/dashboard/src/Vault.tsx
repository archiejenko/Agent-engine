import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";

interface NoteItem {
  path: string;
  title: string;
  tags: string[];
  author: string;
  version: number;
  updated_at: string | null;
  labels: string[];
  edited_here: boolean;
}
interface Note extends NoteItem {
  body: string;
  links: string[];
  backlinks: string[];
  provenance: {
    author: string;
    at: string | null;
    sources: string[];
    ledger_rows: number[];
    labels: string[];
  };
  history: { version: number; author: string; created_at: string }[];
}
interface Ideas {
  present: boolean;
  note?: string;
  columns?: string[];
  missing?: string[];
  rows?: { values: Record<string, string>; kind: string }[];
}

const SCORE_COLUMNS = [
  "Score",
  "Autonomy",
  "Speed to cash",
  "Demand",
  "Margin",
  "Ease of build",
  "Low risk",
];

function IdeasSheet() {
  const [d, setD] = useState<Ideas | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => {
    getJson<Ideas>("/api/vault/ideas").then(setD, () => setD({ present: false }));
  }, []);
  if (!d) return <p>Loading…</p>;
  if (!d.present)
    return (
      <p className="empty">
        The ideas sheet (brain/ideas/seed-500.csv) hasn't been added yet. Once it's in brain/, it
        shows here.
      </p>
    );
  const shown = [
    "Rank",
    "Idea",
    "Category",
    "Buyer",
    "Score",
    ...SCORE_COLUMNS.slice(1),
    "Status",
  ].filter((c) => d.columns?.includes(c));
  const rows = (d.rows ?? []).filter(
    (r) => !q || Object.values(r.values).join(" ").toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <p className="muted">
        {d.note} <span className="kind kind-assumed">assumed</span>
      </p>
      {(d.missing ?? []).length > 0 && (
        <p className="muted">Columns not found: {(d.missing ?? []).join(", ")}</p>
      )}
      <div className="filters">
        <input
          type="search"
          placeholder="Search ideas"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search ideas"
        />
        <span className="muted">
          {rows.length} of {d.rows?.length ?? 0}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            {shown.map((c) => (
              <th key={c} align={SCORE_COLUMNS.includes(c) ? "right" : "left"}>
                {c}
                {SCORE_COLUMNS.includes(c) && <small> (assumed)</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 200).map((r) => (
            <tr key={r.values.ID ?? r.values.Idea}>
              {shown.map((c) => (
                <td key={c} align={SCORE_COLUMNS.includes(c) ? "right" : "left"}>
                  {r.values[c]}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && <EmptyRow cols={shown.length}>No ideas match.</EmptyRow>}
        </tbody>
      </table>
    </>
  );
}

function NoteView({ path }: { path: string }) {
  const [n, setN] = useState<Note | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<Note>(`/api/vault/note?path=${encodeURIComponent(path)}`).then(
      (x) => {
        setN(x);
        setText(x.body);
      },
      (e: Error) => setMsg(e.message),
    );
  }, [path]);
  useEffect(load, [load]);
  if (!n) return <p>{msg ?? "Loading…"}</p>;
  const save = async () => {
    const r = await fetch("/api/vault/note", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, body: text }),
    });
    setMsg(
      r.ok
        ? "Saved as a new version (the previous text is kept in the history)."
        : ((await r.json()).error ?? "Error"),
    );
    setEditing(false);
    load();
  };
  const link = (p: string) => (
    <a key={p} href={`#/vault/${encodeURIComponent(p)}`}>
      {p.replace(/^brain\//, "")}
    </a>
  );
  return (
    <>
      <p>
        <a href="#/vault">← All notes</a>
      </p>
      <h2>{n.title}</h2>
      <p className="muted">
        {n.path} · v{n.version} · by {n.provenance.author}
        {n.provenance.at && ` · ${n.provenance.at.slice(0, 10)}`}
        {n.provenance.labels.map((l) => (
          <span key={l} className={`kind kind-${l === "assumed" ? "assumed" : "synthetic"}`}>
            {l}
          </span>
        ))}
        {n.edited_here && " · edited here, not yet in git"}
      </p>
      {n.provenance.sources.length + n.provenance.ledger_rows.length > 0 && (
        <p className="muted">
          Rests on: {n.provenance.sources.join(", ")}
          {n.provenance.ledger_rows.length > 0 &&
            ` · ledger rows ${n.provenance.ledger_rows.join(", ")}`}
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
      {editing ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={20}
            style={{ width: "100%", font: "inherit" }}
            aria-label="Note text"
          />
          <button type="button" className="primary" onClick={save}>
            Save as new version
          </button>{" "}
          <button type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <pre className="mail-body">{n.body}</pre>
        </>
      )}
      <h3>Links</h3>
      <p>
        {n.links.length ? (
          n.links.map((p, i) => [i ? ", " : "", link(p)])
        ) : (
          <span className="muted">none</span>
        )}
      </p>
      <h3>Backlinks</h3>
      <p>
        {n.backlinks.length ? (
          n.backlinks.map((p, i) => [i ? ", " : "", link(p)])
        ) : (
          <span className="muted">none</span>
        )}
      </p>
      {n.history.length > 0 && (
        <>
          <h3>History</h3>
          {n.history.map((h) => (
            <p key={h.version} className="muted">
              v{h.version} · {h.author} · {h.created_at.slice(0, 16).replace("T", " ")}
            </p>
          ))}
        </>
      )}
    </>
  );
}

/** Vault: brain/ — frameworks, research, lessons, digests, build reports — searchable, with provenance. */
export function Vault({ route }: { route: string }) {
  const rest = decodeURIComponent(route.replace(/^\/vault\/?/, ""));
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [d, setD] = useState<{ tags: string[]; notes: NoteItem[] } | null>(null);
  useEffect(() => {
    if (rest) return;
    const qs = new URLSearchParams({ ...(q ? { search: q } : {}), ...(tag ? { tag } : {}) });
    getJson<{ tags: string[]; notes: NoteItem[] }>(`/api/vault?${qs}`).then(setD, () => setD(null));
  }, [q, tag, rest]);
  if (rest === "ideas")
    return (
      <>
        <p>
          <a href="#/vault">← All notes</a>
        </p>
        <h2>Ideas sheet</h2>
        <IdeasSheet />
      </>
    );
  if (rest.startsWith("brain/")) return <NoteView path={rest} />;
  return (
    <>
      <h2>Vault</h2>
      <div className="filters">
        <input
          type="search"
          placeholder="Search notes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search notes"
        />
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
          <option value="">every tag</option>
          {d?.tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <a href="#/vault/ideas">Ideas sheet</a>
      </div>
      <table>
        <tbody>
          {d?.notes.length === 0 && <EmptyRow cols={2}>No notes match.</EmptyRow>}
          {d?.notes.map((n) => (
            <tr key={n.path}>
              <td>
                <a href={`#/vault/${encodeURIComponent(n.path)}`}>{n.title}</a>
                <div className="muted">
                  {n.path.replace(/^brain\//, "")} · {n.author}
                  {n.labels.map((l) => (
                    <span key={l} className="kind kind-synthetic">
                      {l}
                    </span>
                  ))}
                </div>
              </td>
              <td>{n.tags.join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
