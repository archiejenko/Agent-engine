import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV3Phase4Gate } from "./v3-phase4.ts";

it("v3 Phase 4 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV3Phase4Gate(storage);
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
});
