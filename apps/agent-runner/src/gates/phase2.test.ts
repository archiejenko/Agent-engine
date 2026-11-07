import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runPhase2Gate } from "./phase2.ts";

it("Phase 2 gate passes on a small synthetic world (CI-sized)", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runPhase2Gate(storage, join(import.meta.dirname, "../../../.."), {
    count: 800,
    drafts: 20,
  });
  expect(r.traceProblems).toEqual([]);
  expect(r.claimProblems).toEqual([]);
  for (const c of r.criteria.slice(0, 4)) expect(c.status, c.criterion).toBe("passed (synthetic)");
}, 300_000);
