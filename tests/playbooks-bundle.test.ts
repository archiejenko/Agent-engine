import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { bundle } from "../scripts/gen-playbooks.ts";

it("bundled playbooks match playbooks/*/SKILL.md (run `pnpm gen:playbooks` if this fails)", () => {
  const current = readFileSync(
    resolve(import.meta.dirname, "../packages/infra/src/playbooks.generated.ts"),
    "utf8",
  );
  expect(current).toBe(bundle());
});
