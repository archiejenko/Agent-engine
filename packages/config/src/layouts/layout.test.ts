import { LayoutSpec, PANEL_COMPONENTS, PANEL_QUERIES } from "@ae/contracts";
import { describe, expect, it } from "vitest";
import homeJson from "./home.json" with { type: "json" };
import { BUILT_IN_LAYOUTS, loadLayout } from "./index.ts";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
type Raw = { sections: { id: string; panels: Record<string, unknown>[] }[] };
const firstPanel = (l: Raw) => l.sections[0]?.panels[0] as Record<string, unknown>;

describe("LayoutSpec (cockpit UI plan §3.1)", () => {
  it("home.json is accepted and uses only kit components and registry queries", () => {
    const r = loadLayout("home");
    expect(r.errors).toEqual([]);
    expect(r.fallback).toBe(false);
    const panels = r.layout.sections.flatMap((s) => s.panels);
    for (const p of panels) {
      expect(PANEL_COMPONENTS).toContain(p.component);
      expect(PANEL_QUERIES).toContain(p.query);
    }
    // Plan §4: brief → KPIs → Needs you → money → agent activity → health.
    expect(r.layout.sections.map((s) => s.id)).toEqual([
      "brief_section",
      "kpis_section",
      "needs_you_section",
      "money_section",
      "activity_section",
      "playbooks_section",
      "health_section",
    ]);
  });

  it("the built-in layouts are themselves valid", () => {
    for (const l of Object.values(BUILT_IN_LAYOUTS))
      expect(LayoutSpec.safeParse(l).success).toBe(true);
  });

  const refused = (mutate: (l: Raw) => void) => {
    const raw = clone(homeJson) as unknown as Raw;
    mutate(raw);
    return LayoutSpec.safeParse(raw).success;
  };

  it("refuses an unknown component", () => {
    expect(
      refused((l) => {
        firstPanel(l).component = "PieOfDoom";
      }),
    ).toBe(false);
  });
  it("refuses an unknown query", () => {
    expect(
      refused((l) => {
        firstPanel(l).query = "drop_table";
      }),
    ).toBe(false);
  });
  it("refuses a duplicate panel id, and a panel id that repeats a section id", () => {
    expect(
      refused((l) => {
        const p = clone(firstPanel(l));
        l.sections[0]?.panels.push(p);
      }),
    ).toBe(false);
    expect(
      refused((l) => {
        firstPanel(l).id = "health_section";
      }),
    ).toBe(false);
  });
  it("refuses a bad span (0, 5, 2.5)", () => {
    for (const span of [0, 5, 2.5, "2"])
      expect(
        refused((l) => {
          firstPanel(l).span = span;
        }),
      ).toBe(false);
  });
  it("refuses unknown fields (a typo never silently does nothing)", () => {
    expect(
      refused((l) => {
        firstPanel(l).spam = 2;
      }),
    ).toBe(false);
  });

  it("a broken home.json falls back to the built-in layout and says why", () => {
    const raw = clone(homeJson) as unknown as Raw;
    firstPanel(raw).component = "PieOfDoom";
    const r = loadLayout("home", raw);
    expect(r.fallback).toBe(true);
    expect(r.layout).toEqual(BUILT_IN_LAYOUTS.home);
    expect(r.errors.join(" ")).toMatch(/component/);
    expect(loadLayout("home", "not json at all").fallback).toBe(true);
  });
});
