import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runPhase4Gate } from "./phase4.ts";

it("Phase 4 gate passes on a small synthetic world (CI-sized)", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runPhase4Gate(storage, join(import.meta.dirname, "../../../.."), {
    count: 600,
    calls: 30,
    premium: 10,
  });
  for (const c of r.criteria.filter((x) => x.status !== "live pending"))
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
}, 300_000);
