import { useCallback, useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { recordReview } from "./reviewTimer.ts";

interface Option {
  key: string;
  label: string;
  effect: string;
}
export interface Decision {
  id: string;
  type: string;
  summary: string;
  money_at_stake_gbp: number;
  money_kind: "real" | "estimated" | "assumed" | "none";
  options: Option[];
  recommended: string;
  safe_default: string;
  deadline: string;
  context: Record<string, unknown> | null;
  status: string;
  chosen_option: string | null;
  decided_by: string | null;
  error: string | null;
}

const TYPE: Record<string, string> = {
  lead: "Lead",
  draft: "Draft",
  print_batch: "Print batch",
  claim_publish: "Publish site",
  uncertain_effect: "Check an action",
  dead_letter: "Failed job",
  data_conflict: "Data conflict",
  quarantine: "Unmatched record",
  spend_tier: "Spend tier",
  autonomy: "Autonomy",
  key_failing: "Key failing",
  idea: "Idea",
  idea_budget: "Test budget",
  board: "Board",
  graph_plan: "Plan",
  promotion: "Promotion",
};

function due(deadline: string) {
  const h = Math.round((Date.parse(deadline) - Date.now()) / 3_600_000);
  if (h <= 0) return "due now";
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}

function DraftBody({
  d,
  text,
  setText,
}: {
  d: Decision;
  text: string;
  setText: (t: string) => void;
}) {
  const awaiting = d.context?.awaiting as { kind: string; item: unknown } | null;
  const item = (
    awaiting?.kind === "check_failed" ? (awaiting.item as { draft: unknown }).draft : awaiting?.item
  ) as { subject?: string; body?: string; draft?: { subject: string; body: string } } | undefined;
  const subject = item?.subject ?? item?.draft?.subject ?? "";
  return (
    <>
      {awaiting?.kind === "check_failed" && (
        <p style={{ color: "crimson" }}>
          Failed its check: {((awaiting.item as { reasons?: string[] }).reasons ?? []).join("; ")}
        </p>
      )}
      {subject && <b>{subject}</b>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        style={{ width: "100%", font: "inherit", lineHeight: 1.5 }}
        aria-label="Draft text"
      />
    </>
  );
}

function draftText(d: Decision): string {
  const awaiting = d.context?.awaiting as { kind: string; item: unknown } | null;
  const item = (
    awaiting?.kind === "check_failed" ? (awaiting.item as { draft: unknown }).draft : awaiting?.item
  ) as { body?: string; draft?: { body: string } } | undefined;
  return item?.body ?? item?.draft?.body ?? "";
}

function Card({ d, onDone }: { d: Decision; onDone: (msg: string) => void }) {
  const original = d.type === "draft" ? draftText(d) : "";
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const choose = async (option: string) => {
    setBusy(true);
    recordReview(
      d.type === "draft"
        ? "draft"
        : d.type === "lead"
          ? "opportunity"
          : d.type === "print_batch"
            ? "print_batch"
            : d.type === "claim_publish"
              ? "claim"
              : d.type === "quarantine"
                ? "quarantine"
                : "conflict",
      d.id,
    );
    const edited = d.type === "draft" && option === "approve" && text !== original ? text : null;
    const r = await fetch(`/api/decisions/${d.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option, ...(edited ? { edited_text: edited } : {}) }),
    });
    setBusy(false);
    onDone(r.ok ? `Done: ${d.summary}` : ((await r.json()).error ?? `HTTP ${r.status}`));
  };
  const safe = d.options.find((o) => o.key === d.safe_default);
  return (
    <div className="card decision">
      <div className="decision-head">
        <span className="kind">{TYPE[d.type] ?? d.type}</span>
        <b>{d.summary}</b>
      </div>
      <p className="muted" style={{ margin: "0.2rem 0" }}>
        {d.money_kind !== "none" && (
          <>
            £{Math.round(d.money_at_stake_gbp).toLocaleString("en-GB")} at stake ({d.money_kind}) ·{" "}
          </>
        )}
        {due(d.deadline)} · if you don't decide: <i>{safe?.label}</i> ({safe?.effect})
      </p>
      {d.type === "draft" && <DraftBody d={d} text={text} setText={setText} />}
      {d.type === "graph_plan" && d.context?.graph_id ? (
        <p>
          <a href={`#/plans/${d.context.graph_id as string}`}>
            Open the plan (graph, sandbox, costs)
          </a>
        </p>
      ) : null}
      {d.type === "print_batch" && (
        <p>
          <a href="#/inbox/letters">Open the batch (PDF, flagged letters)</a>
        </p>
      )}
      {d.type === "uncertain_effect" && d.context?.entity_id ? (
        <p>
          <a href={`#/crm/${d.context.entity_id as string}`}>Company</a>
          {d.context.error ? <> · what failed: {String(d.context.error)}</> : null}
        </p>
      ) : null}
      {d.type === "lead" && d.context?.entity_id ? (
        <p>
          <a href={`#/crm/${d.context.entity_id as string}`}>Company</a>
          {d.context.rationale ? <> · {String(d.context.rationale)}</> : null}
        </p>
      ) : null}
      <div className="decision-options">
        {d.options.map((o) => (
          <button
            key={o.key}
            type="button"
            disabled={busy}
            className={o.key === d.recommended ? "primary" : undefined}
            title={o.effect}
            onClick={() => choose(o.key)}
          >
            {d.type === "draft" && o.key === "approve" && text !== original
              ? "Save edit & approve"
              : o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The one queue: everything that needs Archie, highest money at stake first (v3 rule 18). */
export function NeedsYou({ type, title = "Needs you" }: { type?: string; title?: string }) {
  const [list, setList] = useState<Decision[] | null>(null);
  const [recent, setRecent] = useState<Decision[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    getJson<{ open: Decision[]; recent: Decision[] }>(
      `/api/decisions${type ? `?type=${type}` : ""}`,
    ).then(
      (r) => {
        setList(r.open);
        setRecent(r.recent);
      },
      (e: Error) => setMsg(e.message),
    );
  }, [type]);
  useEffect(load, [load]);
  return (
    <section>
      <h2>
        {title} {list && <small className="muted">({list.length})</small>}
      </h2>
      {msg && <p className="muted">{msg}</p>}
      {list === null && <p>Loading…</p>}
      {list?.length === 0 && <p className="empty">Nothing needs you right now.</p>}
      {list?.map((d) => (
        <Card
          key={d.id}
          d={d}
          onDone={(m) => {
            setMsg(m);
            load();
          }}
        />
      ))}
      {!type && recent.some((r) => r.status === "defaulted") && (
        <details>
          <summary>Recently defaulted (not your decision)</summary>
          {recent
            .filter((r) => r.status === "defaulted")
            .map((r) => (
              <p key={r.id} className="muted">
                {r.summary}: took its safe default ({r.chosen_option})
              </p>
            ))}
        </details>
      )}
    </section>
  );
}
