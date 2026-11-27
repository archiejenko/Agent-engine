import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { requestThenDecide } from "./decide.ts";
import { PagePanels } from "./pagePanels.tsx";

interface Tile {
  market_key: string;
  label: string;
  field: string;
  col: string;
  pinned: boolean;
  synthetic: boolean;
  signals: { id: string; type: string; value: unknown; source: string }[];
  cards: { id: string; version: number; status: string; offer: string }[];
  spent_gbp: number;
  spent_synthetic_gbp: number;
  earned_gbp: number;
  earned_synthetic_gbp: number;
}

const COLUMNS = ["scanning", "researching", "proposed", "testing", "live", "killed"] as const;
const gbp = (n: number) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;

/** Markets and industries as tiles in columns (v3 Phase 6). Agents move tiles; you pin or kill one. */
export function Board() {
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ tiles: Tile[] }>("/api/board").then(
      (r) => setTiles(r.tiles),
      (e: Error) => setMsg(e.message),
    );
  }, []);
  useEffect(load, [load]);
  // Pin, unpin or kill: opened as a decision and recorded through /api/decisions/:id/decide.
  const act = async (key: string, action: "pin" | "unpin" | "kill") => {
    const err = await requestThenDecide({ kind: "board", key, action });
    setMsg(err ? err : `Done: ${action}`);
    load();
  };
  return (
    <div>
      <h2>Board</h2>
      <PagePanels page="board" />
      {msg && <p className="muted">{msg}</p>}
      {tiles && tiles.length === 0 && (
        <p className="empty">No markets yet. A scout's first signal puts one here.</p>
      )}
      <div className="board">
        {COLUMNS.map((col) => {
          const inCol = (tiles ?? []).filter((t) => t.col === col);
          return (
            <section key={col} className="board-col">
              <h3>
                {col} <small className="muted">({inCol.length})</small>
              </h3>
              {inCol.map((t) => (
                <div key={t.market_key} className="card">
                  <b>{t.label}</b> {t.pinned && <span className="kind">pinned</span>}
                  {t.synthetic && <span className="kind kind-synthetic">synthetic</span>}
                  <p className="muted small" style={{ margin: "0.2rem 0" }}>
                    {t.signals.length} signal(s):{" "}
                    {t.signals
                      .slice(0, 3)
                      .map((s) => s.type.replaceAll("_", " "))
                      .join(", ")}
                  </p>
                  <p className="small" style={{ margin: "0.2rem 0" }}>
                    {t.cards.map((c) => (
                      <a
                        key={`${c.id}-${c.version}`}
                        href={`#/ideas/${c.id}`}
                        style={{ marginRight: 6 }}
                      >
                        {c.offer} ({c.status})
                      </a>
                    ))}
                  </p>
                  <p className="small" style={{ margin: "0.2rem 0" }}>
                    Spent {gbp(t.spent_gbp)} · earned {gbp(t.earned_gbp)}
                    {(t.spent_synthetic_gbp > 0 || t.earned_synthetic_gbp > 0) && (
                      <span className="muted">
                        {" "}
                        (synthetic: {gbp(t.spent_synthetic_gbp)} / {gbp(t.earned_synthetic_gbp)})
                      </span>
                    )}
                  </p>
                  <div className="decision-options">
                    <button
                      type="button"
                      onClick={() => act(t.market_key, t.pinned ? "unpin" : "pin")}
                    >
                      {t.pinned ? "Unpin" : "Pin"}
                    </button>
                    {t.col !== "killed" && (
                      <button type="button" onClick={() => act(t.market_key, "kill")}>
                        Kill
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
