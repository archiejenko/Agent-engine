import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV3Phase6Gate } from "./v3-phase6.ts";

it("v3 Phase 6 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV3Phase6Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
