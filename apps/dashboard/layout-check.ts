import { checkLayoutFile, LAYOUT_FILES } from "@ae/config/layouts/check";
import type { Plugin } from "vite";

/**
 * The prebuild check (cockpit U2): every page layout file is checked with the full LayoutSpec before
 * Vite builds or serves the dashboard. A bad file stops the build with the reasons, so it never ships.
 * The browser only does a light check (kit/layout.ts) and keeps the built-in fallback.
 */
export function layoutCheck(files: Record<string, string> = LAYOUT_FILES): Plugin {
  return {
    name: "ae-layout-check",
    buildStart() {
      for (const path of Object.values(files)) {
        checkLayoutFile(path);
        this.addWatchFile(path);
      }
    },
  };
}
