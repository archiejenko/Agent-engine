import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV3Phase3Gate } from "./v3-phase3.ts";

it("v3 Phase 3 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV3Phase3Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
