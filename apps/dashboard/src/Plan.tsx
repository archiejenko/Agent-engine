import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";

interface GNode {
  id: string;
  kind: string;
  ref: string;
  category: "agent" | "deterministic" | "needs_you";
  external: boolean;
  max_cost_gbp: number;
}
interface GEdge {
  from: string;
  to: string;
  when?: { key: string; op: string; value?: unknown };
  loop?: { maxIterations: number };
}
interface Figure {
  value: number;
  label: string;
  assumption: string | null;
}
interface SandboxReport {
  scenario: string;
  pass: boolean;
  nodes: { nodeId: string; status: string; costGbp: number }[];
  totals: { sandboxCostGbp: number; projectedLiveCostGbp: number };
  failures: string[];
  guardrailHits: { rule: string; message: string }[];
  model: string;
}
interface PlanData {
  graph_id: string;
  version: number;
  status: string;
  plan_status: string;
  card_id: string | null;
  graph: { nodes: GNode[]; edges: GEdge[]; layers: string[][] } | null;
  goal: string | null;
  success_metric: { name: string; target: number; unit: string; measuredBy: string } | null;
  stop_conditions: string[];
  budget_gbp: number | null;
  expected_value_gbp: Figure | null;
  worst_case_gbp: number | null;
  autonomy: string | null;
  sandbox: SandboxReport[];
  probes: { question: string; ok: boolean; problems: string[]; cost_gbp: number }[];
  diff: {
    first: boolean;
    nodes_added: string[];
    nodes_removed: string[];
    nodes_changed: string[];
    edges_added: string[];
    edges_removed: string[];
    budget: { from: number; to: number } | null;
  } | null;
  note: string;
  actions: {
    decision_id: string;
    options: { key: string; label: string; effect: string }[];
  } | null;
  rationale: {
    model: string;
    promptVersion: string;
    rationale: string;
    assumptions: string[];
  } | null;
  history: { version: number; status: string }[];
}

const gbp = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "—"
    : `£${n.toLocaleString("en-GB", { maximumFractionDigits: 4 })}`;
const COLOUR = { agent: "#dbe8fb", deterministic: "#e9ecef", needs_you: "#fff0c2" } as const;

/**
 * The graph, drawn from the compiler's own layers: one row per layer, top to bottom (graph plan §6, no
 * library). Width follows the container, so it never scrolls sideways on a phone.
 */
export function GraphView({ graph }: { graph: NonNullable<PlanData["graph"]> }) {
  const W = 320;
  const rowH = 64;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [r, layer] of graph.layers.entries())
    for (const [i, id] of layer.entries())
      pos.set(id, { x: ((i + 0.5) * W) / layer.length, y: r * rowH + 24 });
  const H = graph.layers.length * rowH;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", maxWidth: 520, height: "auto" }}
      role="img"
      aria-label="Plan graph"
    >
      {graph.edges.map((e) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        const back = b.y <= a.y;
        return (
          <g key={`${e.from}-${e.to}-${e.when?.value ?? ""}`}>
            <path
              d={
                back
                  ? `M${a.x + 40},${a.y} C${a.x + 90},${a.y} ${b.x + 90},${b.y} ${b.x + 40},${b.y}`
                  : `M${a.x},${a.y + 14} L${b.x},${b.y - 14}`
              }
              stroke={back ? "#b06000" : "#8a96a3"}
              strokeDasharray={back ? "4 3" : undefined}
              fill="none"
            />
            {e.loop && (
              <text x={Math.max(a.x, b.x) + 70} y={(a.y + b.y) / 2} fontSize="9" fill="#b06000">
                ≤{e.loop.maxIterations}×
              </text>
            )}
          </g>
        );
      })}
      {[...pos.entries()].map(([id, p]) => {
        const n = byId.get(id);
        if (!n) return null;
        return (
          <g key={id}>
            <rect
              x={p.x - 46}
              y={p.y - 14}
              width={92}
              height={28}
              rx={6}
              fill={COLOUR[n.category]}
              stroke={n.external ? "#c0392b" : "#8a96a3"}
              strokeWidth={n.external ? 2 : 1}
            />
            <text x={p.x} y={p.y + 4} fontSize="10" textAnchor="middle">
              {id.length > 14 ? `${id.slice(0, 13)}…` : id}
              {n.external ? " ↗" : ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The approval card for a plan: every field Archie judges it on (graph plan G4). */
export function Plan({ id }: { id: string }) {
  const [p, setP] = useState<PlanData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [text, setText] = useState("");
  const load = useCallback(() => {
    getJson<PlanData>(`/api/plans/${id}`).then(setP, (e: Error) => setMsg(e.message));
  }, [id]);
  useEffect(load, [load]);
  const choose = async (option: string) => {
    if (!p?.actions) return;
    if ((option === "edit" || option === "reject") && !text.trim())
      return setMsg(
        option === "edit"
          ? "Write the change you want: it goes back to the planner."
          : "Say why: the planner reads it.",
      );
    const r = await fetch(`/api/decisions/${p.actions.decision_id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option, ...(text.trim() ? { reason: text.trim() } : {}) }),
    });
    setMsg(r.ok ? `Done: ${option}` : ((await r.json()).error ?? `HTTP ${r.status}`));
    load();
  };
  if (!p) return <p className="muted">{msg ?? "Loading…"}</p>;
  return (
    <div>
      <p>{p.card_id ? <a href={`#/ideas/${p.card_id}`}>← Idea</a> : <a href="#/">← Home</a>}</p>
      <h2>
        Plan v{p.version} <small className="muted">{p.plan_status}</small>
      </h2>
      <p className="banner">{p.note}</p>
      <h3>Graph</h3>
      {p.graph ? (
        <GraphView graph={p.graph} />
      ) : (
        <p className="muted">No graph (the planner didn't submit one).</p>
      )}
      <p className="muted small">
        Blue: agent · grey: deterministic · yellow: needs you · red outline ↗: acts externally
      </p>
      <table>
        <tbody>
          <tr>
            <td>Goal</td>
            <td>{p.goal ?? "—"}</td>
          </tr>
          <tr>
            <td>Success metric</td>
            <td>
              {p.success_metric
                ? `${p.success_metric.target} ${p.success_metric.unit} (${p.success_metric.name}, measured by ${p.success_metric.measuredBy})`
                : "—"}
            </td>
          </tr>
          <tr>
            <td>Stop conditions</td>
            <td>{p.stop_conditions.join("; ") || "—"}</td>
          </tr>
          <tr>
            <td>Budget</td>
            <td>
              {gbp(p.budget_gbp)} · worst case {gbp(p.worst_case_gbp)}
            </td>
          </tr>
          <tr>
            <td>Expected value</td>
            <td>
              {p.expected_value_gbp ? (
                <>
                  {gbp(p.expected_value_gbp.value)}{" "}
                  <span className={`kind kind-${p.expected_value_gbp.label}`}>
                    {p.expected_value_gbp.label}
                  </span>
                </>
              ) : (
                "—"
              )}
            </td>
          </tr>
          <tr>
            <td>Autonomy</td>
            <td>{p.autonomy ?? "—"}</td>
          </tr>
        </tbody>
      </table>
      <h3>Sandbox</h3>
      {p.sandbox.length === 0 && <p className="muted">No sandbox runs for this version.</p>}
      {p.sandbox.map((r) => (
        <div key={r.scenario} className="card">
          <b>{r.scenario}</b> <span className="kind">{r.pass ? "pass" : "fail"}</span>{" "}
          <span className="kind">{r.model} model</span>
          <p className="small" style={{ margin: "0.2rem 0" }}>
            {r.nodes.map((n) => `${n.nodeId} ${n.status} ${gbp(n.costGbp)}`).join(" · ")}
          </p>
          <p className="muted small" style={{ margin: 0 }}>
            Sandbox {gbp(r.totals.sandboxCostGbp)} · projected live{" "}
            {gbp(r.totals.projectedLiveCostGbp)}
            {r.failures.length ? ` · ${r.failures.join("; ")}` : ""}
            {r.guardrailHits.length
              ? ` · guardrail hits: ${r.guardrailHits.map((g) => g.rule).join(", ")}`
              : " · no guardrail hits"}
          </p>
        </div>
      ))}
      <h3>Probes</h3>
      {p.probes.length === 0 ? (
        <p className="muted">No probes were run.</p>
      ) : (
        p.probes.map((x) => (
          <p key={x.question} className="small">
            {x.question}: {x.ok ? "ok" : `problems: ${x.problems.join("; ")}`} ({gbp(x.cost_gbp)})
          </p>
        ))
      )}
      <h3>Changes since the previous attempt</h3>
      {!p.diff || p.diff.first ? (
        <p className="muted">First attempt.</p>
      ) : (
        <p className="small">
          {[
            p.diff.nodes_added.length && `added ${p.diff.nodes_added.join(", ")}`,
            p.diff.nodes_removed.length && `removed ${p.diff.nodes_removed.join(", ")}`,
            p.diff.nodes_changed.length && `changed ${p.diff.nodes_changed.join(", ")}`,
            p.diff.edges_added.length && `new edges ${p.diff.edges_added.join(", ")}`,
            p.diff.budget && `budget ${gbp(p.diff.budget.from)} → ${gbp(p.diff.budget.to)}`,
          ]
            .filter(Boolean)
            .join(" · ") || "No structural change."}
        </p>
      )}
      {p.rationale && (
        <p className="muted small">
          Planner ({p.rationale.model}, prompt v{p.rationale.promptVersion}):{" "}
          {p.rationale.rationale}
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
      {p.actions ? (
        <>
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Comment (needed for Edit and Reject)"
            style={{ width: "100%" }}
          />
          <div className="decision-options">
            {p.actions.options.map((o) => (
              <button
                key={o.key}
                type="button"
                title={o.effect}
                className={o.key === "approve" ? "primary" : undefined}
                onClick={() => choose(o.key)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">No decision open for this version ({p.status}).</p>
      )}
    </div>
  );
}
