import type { LayoutSpec } from "@ae/contracts";

/**
 * Cockpit layouts (cockpit UI plan §3.1). The JSON files are the config Archie (or a later approved
 * decision) changes; the built-in layouts below are what a page shows when its file is refused.
 * The built-in Home is deliberately small: the three 10-second questions (money, what needs you,
 * what's broken), nothing else.
 */
export const BUILT_IN_LAYOUTS: Record<"home", LayoutSpec> = {
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
};
