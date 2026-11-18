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
type ScoreKey = "autonomy" | "speed_to_cash" | "demand" | "margin" | "ease_of_build" | "low_risk";
interface IdeaRow {
  id: string;
  rank: number;
  idea: string;
  category: string;
  taxonomy_node: string | null;
  function: string | null;
  function_source: "category" | "estimate" | null;
  market: { buyer: string; industry: string | null };
  buyer: string;
  batch: string;
  status: string;
  decision: string | null;
  scores: Record<ScoreKey, number>;
  score: number;
  matrix: string;
  score_source: "estimate";
  card: string;
}
interface Ideas {
  present: boolean;
  path?: string;
  ok?: boolean;
  note?: string;
  rows?: IdeaRow[];
  rejected?: { row: number; id: string | null; problems: string[] }[];
  file_problems?: string[];
  mismatches?: { id: string; field: string; file: string; computed: string }[];
  backlog?: {
    hypotheses: number;
    last_import: {
      imported_at: string;
      created: number;
      updated: number;
      unchanged: number;
    } | null;
  };
}

const SCORES: [ScoreKey, string][] = [
  ["autonomy", "Autonomy"],
  ["speed_to_cash", "Speed"],
  ["demand", "Demand"],
  ["margin", "Margin"],
  ["ease_of_build", "Ease"],
  ["low_risk", "Low risk"],
];

function IdeasSheet() {
  const [d, setD] = useState<Ideas | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [matrix, setMatrix] = useState("");
  const [batch, setBatch] = useState("");
  const [fn, setFn] = useState("");
  const [industry, setIndustry] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<Ideas>("/api/vault/ideas").then(setD, () => setD({ present: false }));
  }, []);
  useEffect(load, [load]);
  if (!d) return <p>Loading…</p>;
  if (!d.present)
    return (
      <p className="empty">
        The ideas sheet (brain/ideas/seed-500.csv) hasn't been added yet. Once it's in brain/, it
        shows here.
      </p>
    );
  const all = d.rows ?? [];
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const rows = all.filter(
    (r) =>
      (!q ||
        `${r.id} ${r.idea} ${r.buyer} ${r.category}`.toLowerCase().includes(q.toLowerCase())) &&
      (!cat || r.category === cat) &&
      (!matrix || r.matrix === matrix) &&
      (!batch || r.batch === batch) &&
      (!fn || r.function === fn) &&
      (!industry || r.market.industry === industry || (industry === "-" && !r.market.industry)),
  );
  const importNow = async () => {
    const r = await fetch("/api/vault/ideas/import", { method: "POST" });
    const b = (await r.json()) as {
      created?: number;
      updated?: number;
      unchanged?: number;
      message?: string;
    };
    setMsg(
      r.ok
        ? `Imported: ${b.created} new, ${b.updated} updated, ${b.unchanged} unchanged. Your decisions and comments are never overwritten.`
        : (b.message ?? "Import failed"),
    );
    load();
  };
  const last = d.backlog?.last_import;
  return (
    <>
      <p className="muted">
        {d.note} <span className="kind kind-estimated">estimate</span>
      </p>
      <p className="muted">
        Score and matrix are recomputed from the six scores, not copied from the file. Backlog:{" "}
        {d.backlog?.hypotheses ?? 0} hypotheses
        {last
          ? `, last imported ${last.imported_at.slice(0, 16).replace("T", " ")}`
          : ", not imported yet"}
        .{" "}
        <button type="button" onClick={() => void importNow()} disabled={d.ok === false}>
          Import into the backlog
        </button>
      </p>
      {msg && <p role="status">{msg}</p>}
      {(d.file_problems ?? []).length > 0 && <p className="error">{d.file_problems?.join("; ")}</p>}
      {(d.rejected ?? []).length > 0 && (
        <div className="card">
          <b>The file can't be imported: {d.rejected?.length} row(s) need fixing.</b>
          <ul>
            {d.rejected?.slice(0, 20).map((r) => (
              <li key={r.row}>
                Row {r.row}
                {r.id ? ` (${r.id})` : ""}: {r.problems.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(d.mismatches ?? []).length > 0 && (
        <p className="muted">
          {d.mismatches?.length} row(s) where the file's score or matrix disagrees with the six
          scores; the recomputed value is used.
        </p>
      )}
      <div className="filters">
        <input
          type="search"
          placeholder="Search ideas"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search ideas"
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {uniq(all.map((r) => r.category)).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={matrix} onChange={(e) => setMatrix(e.target.value)} aria-label="Matrix">
          <option value="">All matrix</option>
          {["Do first", "Quick win", "Big bet", "Park"].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={batch} onChange={(e) => setBatch(e.target.value)} aria-label="Batch">
          <option value="">All batches</option>
          {uniq(all.map((r) => r.batch)).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={fn} onChange={(e) => setFn(e.target.value)} aria-label="Function">
          <option value="">All functions</option>
          {uniq(all.map((r) => r.function ?? ""))
            .filter(Boolean)
            .map((c) => (
              <option key={c}>{c}</option>
            ))}
        </select>
        <select value={industry} onChange={(e) => setIndustry(e.target.value)} aria-label="Market">
          <option value="">All markets</option>
          <option value="-">No industry named</option>
          {uniq(all.map((r) => r.market.industry ?? ""))
            .filter(Boolean)
            .map((c) => (
              <option key={c}>{c}</option>
            ))}
        </select>
        <span className="muted">
          {rows.length} of {all.length}
        </span>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th align="right">Rank</th>
              <th align="left">Idea</th>
              <th align="left">Category</th>
              <th align="left">Function / market</th>
              <th align="left">Matrix</th>
              <th align="right">
                Score <small>(estimate)</small>
              </th>
              {SCORES.map(([k, label]) => (
                <th key={k} align="right">
                  {label}
                </th>
              ))}
              <th align="left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr key={r.id}>
                <td align="right">{r.rank}</td>
                <td>
                  <a href={r.card}>{r.id}</a> {r.idea}
                </td>
                <td>{r.category}</td>
                <td>
                  {r.function ?? "not assigned"}
                  {r.function_source === "estimate" && (
                    <span className="kind kind-estimated">estimate</span>
                  )}
                  <br />
                  <small className="muted">
                    {r.market.buyer}
                    {r.market.industry ? ` · ${r.market.industry}` : ""}
                  </small>
                </td>
                <td>{r.matrix}</td>
                <td align="right">{r.score}</td>
                {SCORES.map(([k]) => (
                  <td key={k} align="right">
                    {r.scores[k]}
                  </td>
                ))}
                <td>{r.status}</td>
              </tr>
            ))}
            {rows.length === 0 && <EmptyRow cols={7 + SCORES.length}>No ideas match.</EmptyRow>}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && (
        <p className="muted">Showing the first 200; narrow with the filters.</p>
      )}
      <p className="muted">
        Every number above is an estimate: never an outcome, never in the outcome ledger, never used
        to train scoring. Each idea's card (Pass / Fail / Question) arrives with the Ideas feed in
        Phase 6.
      </p>
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
