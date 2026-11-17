import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV3SeedGate } from "./v3-seed.ts";

it("v3 seeded-ideas gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV3SeedGate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 120_000);
