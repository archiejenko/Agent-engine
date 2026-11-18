import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG2Gate } from "./graph-g2.ts";

it("graph G2 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG2Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
