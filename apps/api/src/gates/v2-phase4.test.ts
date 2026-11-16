import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV2Phase4Gate } from "./v2-phase4.ts";

it("v2 Phase 4 gate passes (CI-sized)", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV2Phase4Gate(storage, join(import.meta.dirname, "../../../.."), {
    count: 600,
  });
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
