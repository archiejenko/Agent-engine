import type { PanelRow } from "@ae/contracts";
import { useState } from "react";
import { type ReviewItemType, recordReview } from "../reviewTimer.ts";
import { KindBadge, money, when } from "./format.tsx";

interface Option {
  key: string;
  label: string;
  effect: string;
}

/** Decisions you should read in full before choosing: the card links there instead of approving. */
const READ_FIRST = new Set(["draft", "print_batch", "graph_plan", "claim_publish"]);

const REVIEW_TYPE: Record<string, ReviewItemType> = {
  lead: "opportunity",
  draft: "draft",
  print_batch: "print_batch",
  claim_publish: "claim",
  quarantine: "quarantine",
};

/** The one place a cockpit button records a choice (rule 18): POST /api/decisions/:id/decide. */
export async function decide(id: string, option: string): Promise<string | null> {
  const r = await fetch(`/api/decisions/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ option }),
  });
  if (r.ok) return null;
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
}

/**
 * A Needs-you item: title, money at stake (with its kind), deadline, the recommended option, one button
 * per option, and what happens if you don't decide. The agent's reasoning sits collapsed underneath.
 */
export function DecisionCard({
  d,
  onDone,
  dryRun = false,
}: {
  d: PanelRow;
  onDone?: (id: string, message: string) => void;
  /** Kit page: buttons show but never post. */
  dryRun?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const options = (d.options as Option[] | undefined) ?? [];
  const type = d.type as string;
  const safe = options.find((o) => o.key === d.safe_default);
  const moneyKind = d.money_kind as string;
  const choose = async (o: Option) => {
    if (dryRun) {
      setMsg(`(kit page) would choose "${o.label}"`);
      return;
    }
    setBusy(true);
    recordReview(REVIEW_TYPE[type] ?? "conflict", d.key);
    const err = await decide(d.key, o.key);
    setBusy(false);
    setMsg(err ? `Not done: ${err}` : `Done: ${o.label}`);
    if (!err) onDone?.(d.key, o.label);
  };
  return (
    <article className="decision-card">
      <header>
        <span className="kind">{d.detail ?? type}</span>
        <b>{d.label}</b>
      </header>
      <p className="muted decision-facts">
        {moneyKind !== "none" && (
          <>
            <span className="num">{money(d.money_at_stake_gbp as number, { whole: true })}</span> at
            stake{" "}
            <KindBadge
              kind={
                moneyKind === "real" ? "real" : moneyKind === "assumed" ? "assumed" : "estimated"
              }
            />{" "}
            ·{" "}
          </>
        )}
        due {when(d.deadline as string)} · if you don't decide: <i>{safe?.label ?? "nothing"}</i>
      </p>
      {READ_FIRST.has(type) ? (
        <p>
          <a href={`#${d.drill ?? "/"}`}>Read it in full before deciding ›</a>
        </p>
      ) : (
        <div className="decision-actions">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              disabled={busy}
              className={o.key === d.recommended ? "primary" : undefined}
              title={o.effect}
              onClick={() => choose(o)}
            >
              {o.label}
              {o.key === d.recommended && <small> (recommended)</small>}
            </button>
          ))}
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
      {typeof d.reasoning === "string" && d.reasoning && (
        <details>
          <summary>Why the agent suggests this</summary>
          <p>{d.reasoning}</p>
        </details>
      )}
    </article>
  );
}

/** The Needs-you panel body: cards in the API's order (highest money at stake first). */
export function DecisionList({
  rows,
  onDone,
  dryRun,
}: {
  rows: PanelRow[];
  onDone?: (id: string, message: string) => void;
  dryRun?: boolean;
}) {
  return (
    <div className="decision-list">
      {rows.map((d) => (
        <DecisionCard key={d.key} d={d} {...(onDone ? { onDone } : {})} dryRun={dryRun ?? false} />
      ))}
    </div>
  );
}
