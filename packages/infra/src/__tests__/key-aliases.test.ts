import { loadKeysConfig } from "@ae/config";
import { envKeyStore } from "@ae/ports";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { KeyRing, keyFromEnv, keyNames } from "../keys.ts";

describe("key aliases (keys.json)", () => {
  it("the Claude key may be saved as EXTRACTOR_ANTHROPIC_API_KEY", () => {
    expect(keyNames("ANTHROPIC_API_KEY")).toEqual([
      "ANTHROPIC_API_KEY",
      "EXTRACTOR_ANTHROPIC_API_KEY",
    ]);
    expect(keyNames("GEMINI_API_KEY")).toEqual(["GEMINI_API_KEY"]);
    // Aliases are config, validated like names.
    const c = loadKeysConfig();
    expect(c.keys.find((k) => k.name === "ANTHROPIC_API_KEY")?.aliases).toEqual([
      "EXTRACTOR_ANTHROPIC_API_KEY",
    ]);
  });

  it("scripts: the main name wins; the alias is used only when it's missing", () => {
    expect(keyFromEnv("ANTHROPIC_API_KEY", { EXTRACTOR_ANTHROPIC_API_KEY: "alias-value-1" })).toBe(
      "alias-value-1",
    );
    expect(
      keyFromEnv("ANTHROPIC_API_KEY", {
        ANTHROPIC_API_KEY: "main-value-1",
        EXTRACTOR_ANTHROPIC_API_KEY: "alias-value-1",
      }),
    ).toBe("main-value-1");
    expect(keyFromEnv("ANTHROPIC_API_KEY", {})).toBeNull();
    // An alias belongs to its own key only.
    expect(
      keyFromEnv("GEMINI_API_KEY", { EXTRACTOR_ANTHROPIC_API_KEY: "alias-value-1" }),
    ).toBeNull();
  });

  it("the key ring (model key, tool keys, Keys page) sees a key saved under its alias", async () => {
    const storage = await openSqliteStorage(":memory:");
    const ring = new KeyRing(
      envKeyStore({ EXTRACTOR_ANTHROPIC_API_KEY: "alias-value-1" }),
      storage,
    );
    expect(await ring.modelKey()).toBe("alias-value-1");
    expect((await ring.forTool(["ANTHROPIC_API_KEY"])).keys.ANTHROPIC_API_KEY).toBe(
      "alias-value-1",
    );
    const view = (await ring.list()).find((k) => k.name === "ANTHROPIC_API_KEY");
    expect(view?.saved).toBe(true);
    // The Keys page never shows a value.
    expect(JSON.stringify(await ring.list())).not.toContain("alias-value-1");
  });
});
