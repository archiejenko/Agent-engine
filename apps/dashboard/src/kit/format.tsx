import type { PanelUnit, ValueKind } from "@ae/contracts";

/**
 * Formatting only (cockpit UI plan §2, rule 2): every total, delta, rate and rank arrives from the API.
 * Nothing here adds, subtracts, multiplies or divides a number; Intl does the display (percent style
 * shows a ratio as a percentage without us scaling it). A static test checks the whole kit for this.
 */
const gbp2 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const int = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const one = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const pct = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });
const signedPct = new Intl.NumberFormat("en-GB", {
  style: "percent",
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});
const signedGbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  signDisplay: "exceptZero",
});
const signedNum = new Intl.NumberFormat("en-GB", {
  maximumFractionDigits: 2,
  signDisplay: "exceptZero",
});

export const DASH = "–";

export function money(v: number | null | undefined, opts: { whole?: boolean } = {}): string {
  if (v === null || v === undefined) return DASH;
  return (opts.whole ? gbp0 : gbp2).format(v);
}

export function fmt(v: number | null | undefined, unit: PanelUnit): string {
  if (v === null || v === undefined) return DASH;
  switch (unit) {
    case "gbp":
      return gbp2.format(v);
    case "ratio":
      return pct.format(v);
    case "count":
      return int.format(v);
    case "days":
      return `${one.format(v)} days`;
    case "minutes":
      return `${one.format(v)} min`;
    case "lift":
      return `${one.format(v)}×`;
  }
}

/** A change vs the previous period, as the API computed it. */
export function fmtChange(change: number, unit: PanelUnit): string {
  return unit === "gbp"
    ? signedGbp.format(change)
    : unit === "ratio"
      ? // A change in a rate is in percentage points, not a relative change.
        signedPct.format(change).replace("%", " pts")
      : signedNum.format(change);
}

export const fmtRatio = (v: number | null | undefined) =>
  v === null || v === undefined ? DASH : pct.format(v);
export const fmtSignedRatio = (v: number) => signedPct.format(v);

/** "26 Nov, 14:05" in the viewer's time zone. */
export function when(iso: string | null | undefined): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function dayLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const KIND_LABEL: Record<ValueKind, string> = {
  real: "real",
  estimated: "estimated",
  assumed: "assumed",
  dry_run: "dry run",
  synthetic: "simulated",
};

/** Every number says what it is (design rule 1). */
export function KindBadge({ kind }: { kind: ValueKind | undefined | null }) {
  const k = kind ?? "real";
  return (
    <span className={`kind-badge kind-${k}`} title={`This number is ${KIND_LABEL[k]}`}>
      {KIND_LABEL[k]}
    </span>
  );
}
