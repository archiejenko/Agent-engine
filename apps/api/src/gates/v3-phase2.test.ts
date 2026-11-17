import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV3Phase2Gate } from "./v3-phase2.ts";

it("v3 Phase 2 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV3Phase2Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
