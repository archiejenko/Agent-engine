import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG5Gate } from "./graph-g5.ts";

it("graph G5 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG5Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 600_000);
