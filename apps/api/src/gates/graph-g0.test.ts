import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG0Gate } from "./graph-g0.ts";

it("graph G0 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG0Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 120_000);
