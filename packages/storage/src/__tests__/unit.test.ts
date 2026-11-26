import { describe, expect, it } from "vitest";
import { openSqliteStorage } from "../sqlite.ts";

const entry = (task_id: string) => ({
  task_id,
  step_id: "s",
  role: "writer" as const,
  model: null,
  tool_calls: [],
  output: null,
  check_result: null,
  tokens: { input: 0, output: 0 },
  cost_gbp: 0,
  duration_ms: 1,
  timestamp: "2026-11-26T00:00:00.000Z",
});

describe("storage.unit: one batch per database (data layer plan, step 5)", () => {
  it("sends the queued writes as one batch per store, core first", async () => {
    const s = await openSqliteStorage(":memory:");
    const stores = (
      s.driver as unknown as {
        stores: Record<string, Record<string, (...a: unknown[]) => unknown>>;
      }
    ).stores;
    const calls: string[] = [];
    for (const [name, d] of Object.entries(stores))
      for (const m of ["run", "batch"]) {
        const orig = d[m] as (...a: unknown[]) => unknown;
        d[m] = (...a: unknown[]) => {
          calls.push(`${name}.${m}`);
          return orig.apply(d, a);
        };
      }
    const task = crypto.randomUUID();
    await s.unit(async (u) => {
      await u.controls.set("a", true, "t");
      await u.runLog.append(entry(task));
      await u.controls.set("b", true, "t");
    });
    expect(calls).toEqual(["core.batch", "telemetry.batch"]);
    expect(await s.controls.get("a")).toBe(true);
    expect(await s.controls.get("b")).toBe(true);
    expect(await s.runLog.forTask(task)).toHaveLength(1);
  });

  it("writes nothing if the unit throws", async () => {
    const s = await openSqliteStorage(":memory:");
    const task = crypto.randomUUID();
    await expect(
      s.unit(async (u) => {
        await u.controls.set("a", true, "t");
        await u.runLog.append(entry(task));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await s.controls.get("a")).toBeNull();
    expect(await s.runLog.forTask(task)).toEqual([]);
  });
});
