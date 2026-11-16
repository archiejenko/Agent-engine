import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV2Phase3Gate } from "./v2-phase3.ts";

it("v2 Phase 3 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV2Phase3Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 120_000);
