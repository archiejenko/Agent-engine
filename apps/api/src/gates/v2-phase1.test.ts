import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runV2Phase1Gate } from "./v2-phase1.ts";

it("v2 Phase 1 gate passes in the simulator (CI-sized)", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runV2Phase1Gate(storage, join(import.meta.dirname, "../../../.."), {
    count: 600,
    leads: 6,
    letters: 4,
  });
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
