import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG3Gate } from "./graph-g3.ts";

it("graph G3 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG3Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
