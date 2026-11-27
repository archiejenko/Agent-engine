import type { BUILT_IN_LAYOUTS } from "@ae/config/layouts/builtin";
import { useFilters } from "./filters.ts";
import { pageLayout } from "./layout.ts";
import { LivePanel } from "./render.tsx";

/**
 * A page's panels, drawn from its layout file (packages/config/src/layouts/<page>.json). Each panel
 * loads and fails on its own, so the rest of the page is unaffected. Filters come from the address.
 */
export function PagePanels({
  page,
  args = {},
}: {
  page: Exclude<keyof typeof BUILT_IN_LAYOUTS, "home">;
  /** Extra arguments for every panel on the page (e.g. the Ideas page's function and market). */
  args?: Record<string, string>;
}) {
  const [filters] = useFilters();
  const { layout, fallback } = pageLayout(page);
  return (
    <div className="page-panels">
      {fallback && (
        <p className="muted" role="alert">
          This page's layout file was refused, so a simple built-in layout is shown.
        </p>
      )}
      {layout.sections.map((s) => (
        <div key={s.id} className="panel-grid" id={s.id}>
          {s.panels.map((p) => (
            <LivePanel key={p.id} spec={{ ...p, args: { ...p.args, ...args } }} filters={filters} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default PagePanels;
