import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { Digest } from "./Digest.tsx";
import { Metrics } from "./Metrics.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { Overview } from "./Overview.tsx";

interface Figure {
  key: string;
  label: string;
  value: number | null;
  unit: "gbp" | "count" | "ratio" | "minutes" | "lift";
  kind: "real" | "estimated" | "assumed" | "dry_run" | "synthetic";
  note: string | null;
  ci95?: [number, number] | null;
}

const KIND: Record<Figure["kind"], string> = {
  real: "real",
  estimated: "estimated",
  assumed: "assumed",
  dry_run: "dry run",
  synthetic: "SIMULATED",
};
const PLAYBOOKS = ["", "sme_outreach", "sme_letter", "post_reply", "claim_site"];

function show(f: Figure): string {
  if (f.value === null) return "–";
  if (f.unit === "gbp")
    return `${f.value < 0 ? "−" : ""}£${Math.abs(f.value).toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  if (f.unit === "ratio") return `${(f.value * 100).toFixed(1)}%`;
  if (f.unit === "lift") return `${f.value.toFixed(2)}×`;
  if (f.unit === "minutes") return `${f.value.toFixed(0)} min`;
  return f.value.toLocaleString("en-GB");
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Home: sales and revenue at a glance. Every tile says whether its figure is real, estimated or assumed. */
export function Home() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const [playbook, setPlaybook] = useState("");
  const [sim, setSim] = useState(false);
  const [figures, setFigures] = useState<Figure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams({
      from,
      to,
      ...(playbook ? { playbook } : {}),
      ...(sim ? { synthetic: "1" } : {}),
    });
    getJson<{ figures: Figure[] }>(`/api/home?${q}`).then(
      (r) => setFigures(r.figures),
      (e: Error) => setError(e.message),
    );
  }, [from, to, playbook, sim]);
  return (
    <>
      <NeedsYou />
      <Digest />
      <h2>Home</h2>
      <div className="filters">
        <label>
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label>
          Playbook{" "}
          <select value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
            {PLAYBOOKS.map((p) => (
              <option key={p} value={p}>
                {p || "all"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} /> Include
          simulated
        </label>
      </div>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {!figures && !error && <p>Loading…</p>}
      {figures && (
        <div className="tiles">
          {figures.map((f) => (
            <div key={f.key} className="tile" title={f.note ?? undefined}>
              <span className="tile-value">{show(f)}</span>
              <span className="tile-label">{f.label}</span>
              <span className={`kind kind-${f.kind}`}>{KIND[f.kind]}</span>
              {f.ci95 && (
                <span className="tile-note">
                  95% range {f.ci95[0].toFixed(2)}–{f.ci95[1].toFixed(2)}
                </span>
              )}
              {f.note && <span className="tile-note">{f.note}</span>}
            </div>
          ))}
        </div>
      )}
      <details>
        <summary>Data and today</summary>
        <Overview />
      </details>
      <details>
        <summary>Quality, lift and unit economics</summary>
        <Metrics />
      </details>
    </>
  );
}
