import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { expect, it } from "vitest";
import { runPhase3Gate } from "./phase3.ts";

it("Phase 3 gate passes on a small synthetic world (CI-sized)", async () => {
  const storage = await openSqliteStorage(":memory:");
  const r = await runPhase3Gate(storage, join(import.meta.dirname, "../../../.."), {
    count: 800,
    golden: 40,
    outDir: mkdtempSync(join(tmpdir(), "ae-g3-")),
  });
  for (const c of r.criteria.slice(0, 5))
    expect(c.status, `${c.criterion}: ${c.evidence}`).toBe("passed (synthetic)");
  expect(r.backtest.lift).toBeGreaterThan(1);
}, 300_000);
