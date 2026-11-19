import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runGraphG4Gate } from "./graph-g4.ts";

it("graph G4 gate passes", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runGraphG4Gate(storage, join(import.meta.dirname, "../../../.."));
  for (const c of r.criteria)
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 600_000);
