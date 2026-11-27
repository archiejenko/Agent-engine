import type { LayoutSpec } from "@ae/contracts";

/**
 * Cockpit layouts (cockpit UI plan §3.1). The JSON files are the config Archie (or a later approved
 * decision) changes; the built-in layouts below are what a page shows when its file is refused.
 * The built-in Home is deliberately small: the three 10-second questions (money, what needs you,
 * what's broken), nothing else.
 */
/** A one-panel built-in layout for a page whose file is refused. */
const single = (
  page: string,
  panel: Omit<LayoutSpec["sections"][number]["panels"][number], "id" | "args" | "refresh_s"> & {
    args?: Record<string, string | number | boolean>;
  },
): LayoutSpec => ({
  page,
  version: 0,
  sections: [
    {
      id: `builtin_${page}`,
      title: null,
      panels: [{ id: `builtin_${page}_panel`, args: {}, refresh_s: 0, ...panel }],
    },
  ],
});

export type LayoutPage = "home" | "ideas" | "board" | "crm" | "inbox" | "controls" | "vault";

export const BUILT_IN_LAYOUTS: Record<LayoutPage, LayoutSpec> = {
  home: {
    page: "home",
    version: 0,
    sections: [
      {
        id: "builtin_money",
        title: null,
        panels: [
          {
            id: "builtin_kpis",
            title: "Money",
            component: "Kpi",
            query: "kpis",
            args: { set: "primary" },
            span: 4,
            refresh_s: 300,
            drill: "/",
          },
        ],
      },
      {
        id: "builtin_needs_you",
        title: "Needs you",
        panels: [
          {
            id: "builtin_decisions",
            title: "Needs you",
            component: "DecisionCard",
            query: "needs_you",
            args: {},
            span: 4,
            refresh_s: 60,
            drill: "/",
          },
        ],
      },
      {
        id: "builtin_health",
        title: null,
        panels: [
          {
            id: "builtin_health_strip",
            title: "Health",
            component: "HealthStrip",
            query: "health",
            args: {},
            span: 4,
            refresh_s: 60,
            drill: "/controls",
          },
        ],
      },
    ],
  },
  ideas: single("ideas", {
    title: "Idea board",
    component: "Kanban",
    query: "ideas_board",
    span: 4,
    drill: "/ideas",
  }),
  board: single("board", {
    title: "Industry × what we'd sell",
    component: "Heatmap",
    query: "board_heatmap",
    span: 4,
    drill: "/board",
  }),
  crm: single("crm", {
    title: "Pipeline",
    component: "Kanban",
    query: "crm_pipeline",
    args: { limit: 6 },
    span: 4,
    drill: "/crm",
  }),
  inbox: single("inbox", {
    title: "Sends and replies",
    component: "StatStrip",
    query: "inbox_strip",
    span: 4,
    drill: "/inbox",
  }),
  controls: single("controls", {
    title: "Today's spend against each cap",
    component: "Gauges",
    query: "playbook_board",
    args: { all: 1 },
    span: 4,
    drill: "/controls",
  }),
  vault: single("vault", {
    title: "Learned this week",
    component: "StatusList",
    query: "vault_learned",
    span: 4,
    drill: "/vault",
  }),
};
