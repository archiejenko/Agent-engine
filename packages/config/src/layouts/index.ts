import { type ResolvedLayout, resolveLayout } from "@ae/contracts";
import boardJson from "./board.json" with { type: "json" };
import { BUILT_IN_LAYOUTS } from "./builtin.ts";
import controlsJson from "./controls.json" with { type: "json" };
import crmJson from "./crm.json" with { type: "json" };
import homeJson from "./home.json" with { type: "json" };
import ideasJson from "./ideas.json" with { type: "json" };
import inboxJson from "./inbox.json" with { type: "json" };
import vaultJson from "./vault.json" with { type: "json" };

export { BUILT_IN_LAYOUTS };

const FILES: Record<keyof typeof BUILT_IN_LAYOUTS, unknown> = {
  home: homeJson,
  ideas: ideasJson,
  board: boardJson,
  crm: crmJson,
  inbox: inboxJson,
  controls: controlsJson,
  vault: vaultJson,
};

/** A page's layout: its config file if valid, else the built-in layout plus the reasons it fell back. */
export function loadLayout(
  page: keyof typeof BUILT_IN_LAYOUTS,
  raw: unknown = FILES[page],
): ResolvedLayout {
  return resolveLayout(raw, BUILT_IN_LAYOUTS[page]);
}
