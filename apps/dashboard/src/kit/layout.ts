import { BUILT_IN_LAYOUTS } from "@ae/config/layouts/builtin";
import homeJson from "@ae/config/layouts/home.json";
import type { LayoutSpec, PanelSpec } from "@ae/contracts";
import { PANEL_COMPONENTS, PANEL_QUERIES } from "@ae/contracts/layout-names";

/**
 * Page layouts in the browser (cockpit U2). home.json is checked in full when the dashboard builds
 * (layout-check.ts), so a bad file never ships. This light check is the belt to that brace: it needs no
 * validator library, and anything it doesn't like falls back to the built-in layout.
 */
const ID = /^[a-z][a-z0-9_]*$/;

export function lightCheck(raw: unknown): string[] {
  const problems: string[] = [];
  const l = raw as Partial<LayoutSpec> | null;
  if (!l || typeof l !== "object" || !Array.isArray(l.sections) || !l.sections.length)
    return ["no sections"];
  const seen = new Set<string>();
  const id = (x: unknown, where: string) => {
    if (typeof x !== "string" || !ID.test(x)) problems.push(`${where}: bad id`);
    else if (seen.has(x)) problems.push(`${where}: duplicate id ${x}`);
    else seen.add(x);
  };
  l.sections.forEach((s, i) => {
    id(s?.id, `section ${i}`);
    if (!Array.isArray(s?.panels) || !s.panels.length) problems.push(`section ${i}: no panels`);
    for (const p of (s?.panels ?? []) as Partial<PanelSpec>[]) {
      id(p.id, `panel ${String(p.id)}`);
      if (!(PANEL_COMPONENTS as readonly string[]).includes(p.component as string))
        problems.push(`panel ${String(p.id)}: unknown component`);
      if (!(PANEL_QUERIES as readonly string[]).includes(p.query as string))
        problems.push(`panel ${String(p.id)}: unknown query`);
      if (![1, 2, 3, 4].includes(p.span as number))
        problems.push(`panel ${String(p.id)}: bad span`);
    }
  });
  return problems;
}

/** A page's layout, or the built-in one if the file is refused. */
export function pageLayout(
  page: keyof typeof BUILT_IN_LAYOUTS,
  raw: unknown = homeJson,
): { layout: LayoutSpec; fallback: boolean; problems: string[] } {
  const problems = lightCheck(raw);
  if (problems.length) return { layout: BUILT_IN_LAYOUTS[page], fallback: true, problems };
  // Defaults the full LayoutSpec would fill in (args {}, refresh 0, drill null).
  const l = raw as LayoutSpec;
  return {
    layout: {
      ...l,
      sections: l.sections.map((s) => ({
        ...s,
        title: s.title ?? null,
        panels: s.panels.map((p) => ({
          ...p,
          args: p.args ?? {},
          refresh_s: p.refresh_s ?? 0,
          drill: p.drill ?? null,
        })),
      })),
    },
    fallback: false,
    problems: [],
  };
}
