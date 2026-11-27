import { useEffect, useRef, useState } from "react";
import { requestThenDecide } from "./decide.ts";

/**
 * Controls → Agent pool: record money Archie has added to the agents' pool. A top-up raises what agents
 * may spend, so it is recorded as his approval: it opens a "record top-up" decision and resolves it
 * through /api/decisions/:id/decide (rule 18). Runway on Home links straight here.
 */
export function TopUp({ onDone }: { onDone?: () => void }) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  // #/controls?section=pool (Home's Runway link) scrolls here.
  useEffect(() => {
    if (new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("section") === "pool")
      ref.current?.scrollIntoView({ block: "start" });
  }, []);
  const value = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(value) && value > 0 && value <= 100_000;
  const submit = async () => {
    if (!valid) return setMsg("Enter an amount in pounds, more than £0.");
    if (
      !window.confirm(
        `Record a £${value.toFixed(2)} top-up to the agent pool? This is recorded as your approval.`,
      )
    )
      return;
    setBusy(true);
    const err = await requestThenDecide({
      kind: "pool_topup",
      amount_gbp: value,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setBusy(false);
    setMsg(err ? `Not recorded: ${err}` : `Recorded: £${value.toFixed(2)} added to the pool.`);
    if (!err) {
      setAmount("");
      setNote("");
      onDone?.();
    }
  };
  return (
    <section id="pool" ref={ref} className="card topup" aria-label="Record a top-up">
      <h3>Record a top-up</h3>
      <p className="muted">
        Money you've added to the agents' pool. Runway is the pool divided by the last 7 days' live
        spend.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="topup-form"
      >
        <label>
          Amount (£){" "}
          <input
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Note{" "}
          <input
            type="text"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. card payment 27 Nov"
          />
        </label>
        <button type="submit" className="primary" disabled={busy}>
          Record top-up
        </button>
      </form>
      {msg && <p className="muted">{msg}</p>}
    </section>
  );
}
