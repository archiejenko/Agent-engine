import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LayoutSpec } from "@ae/contracts";

/** Every page layout file, checked when the dashboard builds (cockpit U2). */
export const LAYOUT_FILES = { home: join(import.meta.dirname, "home.json") } as const;

export class LayoutFileError extends Error {}

/**
 * Checks a layout file with the full LayoutSpec. Throws LayoutFileError naming the file and every
 * problem, so a bad file fails the build instead of shipping. Returns the checked layout.
 */
export function checkLayoutFile(path: string): LayoutSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new LayoutFileError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  const r = LayoutSpec.safeParse(raw);
  if (!r.success)
    throw new LayoutFileError(
      `${path} is not a valid layout:\n${r.error.issues
        .map((i) => `  - ${i.path.join(".") || "layout"}: ${i.message}`)
        .join("\n")}`,
    );
  return r.data;
}
