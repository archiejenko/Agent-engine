/**
 * What every panel query returns (cockpit UI plan §3.2). One shape for all ten, so one kit component
 * can draw any query of its kind. Every number is computed by the API (rule 4); the dashboard only
 * formats. Type-only: the dashboard imports these with `import type`, so no runtime code ships.
 */

/** What a number is (design rule 1). `synthetic` shows only with the simulated switch on (rule 10). */
export type ValueKind = "real" | "estimated" | "assumed" | "dry_run" | "synthetic";

export type PanelUnit = "gbp" | "count" | "ratio" | "minutes" | "lift" | "days";

export interface PanelFigure {
  key: string;
  label: string;
  value: number | null;
  unit: PanelUnit;
  kind: ValueKind;
  note: string | null;
  ci95?: [number, number] | null;
  /** Same figure over the previous window of the same length (compare=1). */
  previous?: number | null;
  /** value − previous, computed by the API. */
  change?: number | null;
  /** (value − previous) ÷ |previous|, or null when previous is 0 or missing. */
  change_ratio?: number | null;
  /** Whether a rise is good news (spend and costs: false). */
  up_is_good?: boolean;
  /** Up to 14 daily values, oldest first. */
  spark?: number[];
  /** A goal or range to mark, when one is configured. */
  goal?: number | null;
}

export interface PanelPoint {
  day: string;
  revenue_gbp: number;
  spend_gbp: number;
  synthetic?: boolean;
  kind?: ValueKind;
}

/** A row in a list panel. Fields vary by query; these are the ones the guard and kit rely on. */
export interface PanelRow {
  key: string;
  label: string;
  detail?: string | null;
  status?: "ok" | "warn" | "bad" | "info" | "running" | "waiting" | "paused";
  kind?: ValueKind;
  synthetic?: boolean;
  entity_id?: string | null;
  drill?: string | null;
  [field: string]: unknown;
}

export interface PanelStage {
  key: string;
  label: string;
  count: number;
  unit: string;
  /** Bar length: count ÷ the largest count in the funnel (0–1), computed by the API. */
  share: number;
  /** Conversion from the stage before, only when both count the same thing; else null. */
  rate_from_previous: number | null;
  kind: ValueKind;
  note?: string | null;
  /** Money in this stage or column (e.g. pipeline value), computed by the API. */
  value_gbp?: number | null;
}

export interface PanelResult {
  query: string;
  /** Which payload is filled. */
  kind: "figures" | "series" | "rows" | "stages";
  as_of: string;
  from: string;
  to: string;
  note: string | null;
  /** What will fill this panel when it's empty (design rule: empty states say what fills them). */
  empty: string;
  /** The weakest kind among the panel's numbers, for charts and lists that show one badge. */
  value_kind?: ValueKind;
  /** True when simulated rows are included: the page shows its banner (rule 10). */
  synthetic_included: boolean;
  figures?: PanelFigure[];
  series?: PanelPoint[];
  rows?: PanelRow[];
  stages?: PanelStage[];
  /** Query-specific totals or scale (e.g. the shared y-axis max for small multiples). */
  meta?: Record<string, number | string | null>;
}
