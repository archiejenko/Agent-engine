import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_LAYOUTS } from "@ae/config/layouts/builtin";
import { LAYOUT_FILES, LayoutFileError } from "@ae/config/layouts/check";
import homeJson from "@ae/config/layouts/home.json";
import { describe, expect, it } from "vitest";
import { layoutCheck } from "../../layout-check.ts";
import { lightCheck, pageLayout } from "./layout.ts";

/** Runs the plugin's buildStart the way Vite does. */
function buildStart(files: Record<string, string>) {
  const hook = layoutCheck(files).buildStart as (this: unknown) => void;
  hook.call({ addWatchFile: () => {} });
}

const broken = (mutate: (l: { sections: { panels: Record<string, unknown>[] }[] }) => void) => {
  const l = JSON.parse(JSON.stringify(homeJson));
  mutate(l);
  const path = join(mkdtempSync(join(tmpdir(), "layout-")), "home.json");
  writeFileSync(path, JSON.stringify(l));
  return path;
};

describe("home.json is checked when the dashboard builds (prebuild step)", () => {
  it("the real file passes", () => {
    expect(() => buildStart(LAYOUT_FILES)).not.toThrow();
  });

  it("a bad file stops the build and says why", () => {
    const path = broken((l) => {
      const p = l.sections[0]?.panels[0];
      if (p) p.component = "PieOfDoom";
    });
    expect(() => buildStart({ home: path })).toThrow(LayoutFileError);
    expect(() => buildStart({ home: path })).toThrow(/component/);
    const notJson = join(mkdtempSync(join(tmpdir(), "layout-")), "home.json");
    writeFileSync(notJson, "{ nope");
    expect(() => buildStart({ home: notJson })).toThrow(/not valid JSON/);
  });

  it("the check is wired into the Vite build, before the React plugin", () => {
    const cfg = readFileSync(join(import.meta.dirname, "../../vite.config.ts"), "utf8");
    expect(cfg).toMatch(/plugins:\s*\[layoutCheck\(\),\s*react\(\)\]/);
  });
});

describe("the browser's light check keeps the built-in fallback", () => {
  it("accepts home.json and fills the defaults", () => {
    const r = pageLayout("home");
    expect(r.fallback).toBe(false);
    expect(r.layout.sections.map((s) => s.id)[0]).toBe("brief_section");
  });

  it("refuses an unknown component, unknown query, duplicate id or bad span, and falls back", () => {
    for (const mutate of [
      (p: Record<string, unknown>) => {
        p.component = "PieOfDoom";
      },
      (p: Record<string, unknown>) => {
        p.query = "drop_table";
      },
      (p: Record<string, unknown>) => {
        p.id = "health";
      },
      (p: Record<string, unknown>) => {
        p.span = 5;
      },
    ]) {
      const l = JSON.parse(JSON.stringify(homeJson));
      mutate(l.sections[0].panels[0]);
      expect(lightCheck(l).length).toBeGreaterThan(0);
      const r = pageLayout("home", l);
      expect(r.fallback).toBe(true);
      expect(r.layout).toEqual(BUILT_IN_LAYOUTS.home);
    }
  });
});
