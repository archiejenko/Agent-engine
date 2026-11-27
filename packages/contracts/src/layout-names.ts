/**
 * The names a layout may use, with no runtime dependencies (no Zod), so the dashboard can import them
 * without shipping the validator. The full check is LayoutSpec in layout.ts.
 */

/** The component kit (apps/dashboard/src/kit/). A layout naming anything else is refused. */
export const PANEL_COMPONENTS = [
  "Kpi",
  "TrendChart",
  "Funnel",
  "Leaderboard",
  "SegmentedBar",
  "Heatmap",
  "SmallMultiples",
  "StatusList",
  "HealthStrip",
  "DecisionCard",
  // Cockpit U3 (other pages)
  "Kanban",
  "Gauges",
  "StatStrip",
] as const;
export type PanelComponent = (typeof PANEL_COMPONENTS)[number];

/** The panel registry (apps/api/src/panels.ts). A layout naming anything else is refused. */
export const PANEL_QUERIES = [
  "kpis",
  "money_by_day",
  "runway",
  "needs_you",
  "brief",
  "live_runs",
  "pipeline",
  "playbook_board",
  "spend_split",
  "health",
  // Cockpit U3 (other pages)
  "ideas_board",
  "board_heatmap",
  "crm_pipeline",
  "inbox_strip",
  "vault_learned",
] as const;
export type PanelQuery = (typeof PANEL_QUERIES)[number];
