import { loadGraphPolicy } from "@ae/config";
import type { CompiledGraph } from "@ae/contracts";
import { describe, expect, it } from "vitest";
import { compile } from "../compiler.ts";
import {
  type Bindings,
  GraphGuardError,
  GraphPausedError,
  type NodeContext,
  newRunState,
  runGraph,
} from "../interpreter.ts";
import { baseContext, baseSpec, fixtureLibrary } from "../rule-fixtures.ts";

const policy = loadGraphPolicy();
async function compiled(): Promise<CompiledGraph> {
  const r = await compile(baseSpec(), fixtureLibrary(policy), policy, baseContext());
  if (!r.compiled) throw new Error(JSON.stringify(r.errors));
  return r.compiled;
}

/** Fake bindings: the checker fails `failFirst` times; records what each node saw. */
function fakes(o: { failFirst?: number; allowed?: boolean; badWrite?: boolean } = {}) {
  const seen: { id: string; keys: string[] }[] = [];
  let checks = 0;
  const b: Bindings = {
    async run(ctx: NodeContext) {
      seen.push({ id: ctx.node.id, keys: Object.keys(ctx.inputs).sort() });
      switch (ctx.node.id) {
        case "research":
          return {
            status: "done",
            writes: o.badWrite ? { brief: {}, draft: "sneaky" } : { brief: { facts: 1 } },
          };
        case "draft":
          return { status: "done", writes: { draft: { body: `v${ctx.iteration}` } } };
        case "check": {
          const pass = checks++ >= (o.failFirst ?? 0);
          return {
            status: "done",
            writes: {
              check_out: {},
              verdict: pass ? "pass" : "fail",
              feedback: pass ? "" : "too long",
            },
          };
        }
        case "approve":
          return { status: "waiting", item: ctx.inputs.draft };
        case "suppression":
        case "cooldown":
          return { status: "done", writes: { allowed: o.allowed ?? true } };
        default:
          return { status: "done", writes: { delivery: { sent: true } } };
      }
    },
  };
  return { b, seen };
}

describe("interpreter", () => {
  it("a node sees only the keys it declares, in topological order, and waits at the approval", async () => {
    const c = await compiled();
    const { b, seen } = fakes();
    const s = await runGraph(c, b, newRunState("a".repeat(32), c, { entity_ref: "12345678" }));
    expect(s.status).toBe("waiting");
    expect(s.waitingOn).toBe("approve");
    expect(seen.map((x) => x.id)).toEqual(["research", "draft", "check", "approve"]);
    expect(seen[0]?.keys).toEqual(["entity_ref"]);
    expect(seen[2]?.keys).toEqual(["brief", "draft"]);
  });

  it("an undeclared write is refused", async () => {
    const c = await compiled();
    const { b } = fakes({ badWrite: true });
    await expect(runGraph(c, b, newRunState("b".repeat(32), c, {}))).rejects.toThrow(
      GraphGuardError,
    );
  });

  it("a failed check sends the run back once (loop bound), with feedback; then resumes after approval", async () => {
    const c = await compiled();
    const { b, seen } = fakes({ failFirst: 1 });
    let s = await runGraph(c, b, newRunState("c".repeat(32), c, { entity_ref: "x" }));
    expect(seen.map((x) => x.id)).toEqual([
      "research",
      "draft",
      "check",
      "draft",
      "check",
      "approve",
    ]);
    expect(s.iterations.draft).toBe(2);
    s = await runGraph(c, b, s, {
      nodeId: "approve",
      outcome: { status: "done", writes: { approved: true } },
    });
    expect(s.status).toBe("done");
    expect(s.values.delivery).toEqual({ sent: true });
  });

  it("when the loop is used up and no other edge matches, the run stops (it never loops forever)", async () => {
    const c = await compiled();
    const { b, seen } = fakes({ failFirst: 99 });
    const s = await runGraph(c, b, newRunState("d".repeat(32), c, {}));
    expect(seen.filter((x) => x.id === "check")).toHaveLength(2);
    expect(s.status).toBe("done"); // "check" is an exit in the fixture graph
  });

  it("a rejected approval ends the run; a blocked outreach check stops it before the send", async () => {
    const c = await compiled();
    const { b } = fakes();
    let s = await runGraph(c, b, newRunState("e".repeat(32), c, {}));
    s = await runGraph(c, b, s, { nodeId: "approve", outcome: { status: "rejected" } });
    expect(s.status).toBe("rejected");
    const blocked = fakes({ allowed: false });
    let t = await runGraph(c, blocked.b, newRunState("f".repeat(32), c, {}));
    t = await runGraph(c, blocked.b, t, {
      nodeId: "approve",
      outcome: { status: "done", writes: { approved: true } },
    });
    expect(t.status).toBe("stopped");
    expect(t.stoppedAt).toBe("suppression");
    expect(blocked.seen.some((x) => x.id === "send")).toBe(false);
  });

  it("beforeNode can pause a run before its next node (caps and kill switches)", async () => {
    const c = await compiled();
    const { b } = fakes();
    b.beforeNode = async (ctx) => {
      if (ctx.node.id === "check") throw new GraphPausedError("kill switch");
    };
    const s = await runGraph(c, b, newRunState("0".repeat(32), c, {}));
    expect(s.status).toBe("paused");
    expect(s.stoppedAt).toBe("check");
  });
});
