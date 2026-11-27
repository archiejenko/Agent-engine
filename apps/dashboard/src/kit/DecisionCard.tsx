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
export async function decide(
  id: string,
  option: string,
  extra: { reason?: string; edited_text?: string; exclude?: string[] } = {},
): Promise<string | null> {
  const r = await fetch(`/api/decisions/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ option, ...extra }),
  });
  if (r.ok) return null;
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;
}

/**
 * A Needs-you item as one compact row: type, title, money at stake (with its kind), due date and the
 * buttons. "Details" expands the agent's reason and the economics: what each option does and what
 * happens if you don't decide.
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
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const options = (d.options as Option[] | undefined) ?? [];
  const type = d.type as string;
  const safe = options.find((o) => o.key === d.safe_default);
  const moneyKind = d.money_kind as string;
  const detailsId = `decision-${d.key}`;
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
    <article className="decision-card compact">
      <div className="decision-line">
        <span className="kind">{d.detail ?? type}</span>
        <b className="decision-title">{d.label}</b>
        {moneyKind !== "none" && (
          <span className="decision-money num">
            {money(d.money_at_stake_gbp as number, { whole: true })}{" "}
            <KindBadge
              kind={
                moneyKind === "real" ? "real" : moneyKind === "assumed" ? "assumed" : "estimated"
              }
            />
          </span>
        )}
        <span className="decision-due muted">due {when(d.deadline as string)}</span>
        {typeof d.company_drill === "string" && (
          <a className="decision-company" href={`#${d.company_drill}`}>
            Company ›
          </a>
        )}
        {READ_FIRST.has(type) ? (
          <a className="decision-read" href={`#${d.drill ?? "/?tab=queue"}`}>
            Read it first ›
          </a>
        ) : (
          <span className="decision-actions">
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
              </button>
            ))}
          </span>
        )}
        <button
          type="button"
          className="decision-more"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          {open ? "Less" : "Details"}
        </button>
      </div>
      {msg && <p className="muted decision-msg">{msg}</p>}
      {open && (
        <div className="decision-details" id={detailsId}>
          {typeof d.failure === "string" && d.failure && (
            <p className="decision-failure">
              <b>What failed:</b> {d.failure}
            </p>
          )}
          {typeof d.recipient === "string" && d.recipient && (
            <p>
              <b>To:</b> {d.recipient}
            </p>
          )}
          {typeof d.company_drill === "string" && (
            <p>
              <a href={`#${d.company_drill}`}>Open the company</a>
            </p>
          )}
          {typeof d.reasoning === "string" && d.reasoning ? (
            <p>
              <b>Why:</b> {d.reasoning}
            </p>
          ) : (
            <p className="muted">The agent gave no reason for this one.</p>
          )}
          <ul>
            {options.map((o) => (
              <li key={o.key}>
                <b>{o.label}</b>
                {o.key === d.recommended && " (recommended)"}: {o.effect}
              </li>
            ))}
          </ul>
          <p className="muted">
            If you don't decide by {when(d.deadline as string)}: <i>{safe?.label ?? "nothing"}</i>
            {safe?.effect ? ` (${safe.effect})` : ""}. That's recorded as "defaulted", never as your
            approval.
          </p>
        </div>
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
