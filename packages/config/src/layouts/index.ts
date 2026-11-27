import { type ResolvedLayout, resolveLayout } from "@ae/contracts";
import { BUILT_IN_LAYOUTS } from "./builtin.ts";
import homeJson from "./home.json" with { type: "json" };

export { BUILT_IN_LAYOUTS };

const FILES: Record<keyof typeof BUILT_IN_LAYOUTS, unknown> = { home: homeJson };

/** A page's layout: its config file if valid, else the built-in layout plus the reasons it fell back. */
export function loadLayout(
  page: keyof typeof BUILT_IN_LAYOUTS,
  raw: unknown = FILES[page],
): ResolvedLayout {
  return resolveLayout(raw, BUILT_IN_LAYOUTS[page]);
}
