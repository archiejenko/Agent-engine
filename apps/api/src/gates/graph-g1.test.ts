import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG1Gate } from "./graph-g1.ts";

it("graph G1 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG1Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
