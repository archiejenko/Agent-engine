import { z } from "zod";

/**
 * Cockpit layout as data (cockpit UI plan §3.1). A page is a list of sections; a section is a list of
 * panels; a panel names one kit component, one read-only panel query and fixed arguments. Moving,
 * adding or removing a panel is a config change (packages/config/src/layouts/*.json), not a code change.
 * The browser never computes figures: a panel only formats what its query returns (rule 4).
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
] as const;
export type PanelQuery = (typeof PANEL_QUERIES)[number];

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/, "lower_snake_case id");
/** A dashboard route (hash path), e.g. "/crm" or "/controls/keys". */
const Route = z.string().regex(/^\/[a-z0-9/_-]*(\?[a-z0-9_=&-]*)?$/);

export const PanelSpec = z.strictObject({
  id: Id,
  title: z.string().min(1).max(80),
  component: z.enum(PANEL_COMPONENTS),
  query: z.enum(PANEL_QUERIES),
  /** Fixed arguments for the query, e.g. { "group": "playbook" }. Scalars only. */
  args: z.record(Id, z.union([z.string().max(100), z.number(), z.boolean()])).default({}),
  /** Columns on a desktop grid of 4 (phones always stack to one). */
  span: z.number().int().min(1).max(4),
  /** Seconds between automatic refreshes while the tab is visible; 0 = never. */
  refresh_s: z.number().int().min(0).max(3600).default(0),
  /** The page or filtered list behind the panel (rule: everything drills down). */
  drill: Route.nullable().default(null),
});
export type PanelSpec = z.infer<typeof PanelSpec>;

export const SectionSpec = z.strictObject({
  id: Id,
  title: z.string().min(1).max(80).nullable().default(null),
  panels: z.array(PanelSpec).min(1).max(24),
});
export type SectionSpec = z.infer<typeof SectionSpec>;

export const LayoutSpec = z
  .strictObject({
    page: Id,
    /** 0 = a built-in layout; config files start at 1. */
    version: z.number().int().min(0),
    sections: z.array(SectionSpec).min(1).max(20),
  })
  .superRefine((l, ctx) => {
    const seen = new Set<string>();
    for (const id of [
      ...l.sections.map((s) => s.id),
      ...l.sections.flatMap((s) => s.panels.map((p) => p.id)),
    ]) {
      if (seen.has(id)) ctx.addIssue({ code: "custom", message: `duplicate id: ${id}` });
      seen.add(id);
    }
  });
export type LayoutSpec = z.infer<typeof LayoutSpec>;

export interface ResolvedLayout {
  layout: LayoutSpec;
  /** true when the config was refused and the built-in layout is shown instead. */
  fallback: boolean;
  /** Why the config was refused (empty when it was accepted). */
  errors: string[];
}

/**
 * Checks a layout when it loads. A refused layout never half-renders: the page gets the built-in
 * layout (itself checked, so a broken built-in fails loudly in tests) and the reasons.
 */
export function resolveLayout(raw: unknown, builtIn: LayoutSpec): ResolvedLayout {
  const r = LayoutSpec.safeParse(raw);
  if (r.success) return { layout: r.data, fallback: false, errors: [] };
  return {
    layout: LayoutSpec.parse(builtIn),
    fallback: true,
    errors: r.error.issues.map((i) => `${i.path.join(".") || "layout"}: ${i.message}`),
  };
}
