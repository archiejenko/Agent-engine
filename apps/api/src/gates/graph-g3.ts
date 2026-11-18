import { join } from "node:path";
import {
  AgentService,
  failureScenarios,
  type GateCriterion,
  HAPPY_PATH,
  loadPlaybooks,
  runSandbox,
  SandboxIsolationError,
  type SandboxRunResult,
  type ServiceDeps,
} from "@ae/agent-runner";
import { loadGraphPolicy, loadInfraConfig } from "@ae/config";
import { SANDBOX_NOTE } from "@ae/contracts";
import { checkProbe, sandboxCapReason } from "@ae/graph";
import {
  checkBudgetAlerts,
  createTask,
  K,
  KeyRing,
  LocalBudgetPort,
  loadCompiled,
  pauseReason,
} from "@ae/infra";
import { FakeKeyStore } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { libraryFor } from "./graph-lib.ts";

/** The six playbooks converted mechanically in G1 (claim_site stays on its workflow). */
export const SANDBOXED = [
  "sme_outreach",
  "sme_letter",
  "post_reply",
  "human_report",
  "monitoring_subscription",
  "watch_alert",
];

/**
 * Graph G3 gate: the sandbox. Every converted playbook runs as a graph in a fresh synthetic world with
 * fakes for every port; external tools are forced dry; nothing reaches the network; spend is recorded as
 * sandbox spend and never as live. Sandbox proves mechanics and cost, not demand.
 */
export async function runGraphG3Gate(_storage: Storage, root: string) {
  const policy = loadGraphPolicy();
  const playbooks = await loadPlaybooks(join(root, "playbooks"));

  // Everything below runs with the network watched: any fetch is counted (and refused).
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    fetches.push(String(input));
    throw new Error("the sandbox has no network");
  }) as typeof fetch;

  try {
    // 1. Every live port is refused when a sandbox service is built.
    const s0 = await openSqliteStorage(":memory:");
    const base: ServiceDeps = { storage: s0, playbooks, sandbox: true };
    const live: [string, Partial<ServiceDeps>][] = [
      ["key ring", { keys: new KeyRing(new FakeKeyStore(), s0) }],
      ["workflow port", { workflowPort: { start: async () => {}, sendEvent: async () => {} } }],
      ["graph dispatch", { graphDispatch: async () => {} }],
      ["email sender", { email: { send: async () => ({ id: "x" }) } as never }],
      ["inbox", { inbox: { poll: async () => [] } as never }],
      ["alert channel", { alerts: { send: async () => {} } as never }],
      ["web fetcher", { fetcher: { fetch: async () => null } as never }],
      ["budget port", { budget: new LocalBudgetPort() }],
    ];
    const refused = live.filter(([, extra]) => {
      try {
        new AgentService({ ...base, ...extra });
        return false;
      } catch (e) {
        return e instanceof SandboxIsolationError;
      }
    });

    // 2. With every kill switch OFF, every external tool still runs dry in the sandbox and gets no key.
    // The same calls outside the sandbox would run live, which proves the check can fail.
    const probeCalls = async (sandbox: boolean) => {
      const st = await openSqliteStorage(":memory:");
      const svc = new AgentService({ storage: st, playbooks, sandbox });
      svc.tools.keys = new KeyRing(new FakeKeyStore(), st); // present, and must still not be used
      await st.controls.set(K.global, false, "gate");
      const externals = svc.tools.list().filter((t) => t.external);
      const seen: { tool: string; dryRun: boolean; keys: boolean }[] = [];
      for (const reg of externals) {
        await st.controls.set(K.playbook("sme_outreach"), false, "gate");
        svc.tools.register({ ...reg, keys: [] }, async (_a, env) => {
          seen.push({ tool: reg.name, dryRun: env.dryRun, keys: env.keys !== undefined });
          return { result: { ok: true } };
        });
      }
      const { task } = await createTask(st, loadInfraConfig(), playbooks, svc.queue, {
        idempotency_key: `g3-iso-${sandbox}`,
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: "opportunity:g3:entity:00000001",
        lane: "open",
      });
      for (const reg of externals)
        await svc.tools
          .call(
            reg.name,
            { probe: reg.name },
            {
              task: task as StoredTask,
              role: "operator",
              step_tools: [reg.name],
            },
          )
          .catch(() => undefined);
      return { externals: externals.map((t) => t.name), seen };
    };
    const inSandbox = await probeCalls(true);
    const outside = await probeCalls(false);

    // 3. Every converted playbook: a happy path and its failure scenarios, each in a fresh world.
    const results: { playbook: string; r: SandboxRunResult; storage: Storage }[] = [];
    for (const pb of SANDBOXED) {
      const hs = await openSqliteStorage(":memory:");
      const happy = await runSandbox({
        storage: hs,
        playbooks,
        playbook: pb,
        scenario: HAPPY_PATH,
      });
      results.push({ playbook: pb, r: happy, storage: hs });
      for (const sc of failureScenarios(happy)) {
        const fs = await openSqliteStorage(":memory:");
        results.push({
          playbook: pb,
          r: await runSandbox({ storage: fs, playbooks, playbook: pb, scenario: sc }),
          storage: fs,
        });
      }
    }
    const byPb = SANDBOXED.map((pb) => {
      const rs = results.filter((x) => x.playbook === pb);
      return {
        pb,
        happy: rs.find((x) => x.r.report.scenario === HAPPY_PATH.name),
        failures: rs.filter((x) => x.r.report.scenario !== HAPPY_PATH.name),
      };
    });

    // 4. Sandbox spend is never live spend.
    const spend = await Promise.all(
      results.map(async ({ storage, r }) => {
        const all = await storage.costEvents.forRun(r.report.runId);
        const liveRows = await storage.costEvents.range({
          from: "1970-01-01T00:00:00.000Z",
          to: "9999-12-31T00:00:00.000Z",
          modes: ["live"],
        });
        const run = await storage.graphRuns.get(r.report.runId);
        const compiled = await loadCompiled(storage, r.report.graphId, r.report.version);
        const alerts = await checkBudgetAlerts(
          { storage, cfg: loadInfraConfig(), policy },
          r.report.runId,
          compiled,
        );
        return {
          events: all.length,
          modes: [...new Set(all.map((e) => e.mode))],
          live: liveRows.length,
          runMode: run?.mode,
          synthetic: r.task.synthetic,
          dailyAlerts: alerts.filter((a) => /daily cap/.test(a)).length,
        };
      }),
    );
    const totalEvents = spend.reduce((a, x) => a + x.events, 0);

    // 5. The per-attempt sandbox cap pauses a run before a node that would cross it.
    const capRun = results[0] as (typeof results)[number];
    const capCompiled = await loadCompiled(
      capRun.storage,
      capRun.r.report.graphId,
      capRun.r.report.version,
    );
    await capRun.storage.graphRuns.addCost(
      capRun.r.report.runId,
      policy.sandbox.max_cost_per_attempt_gbp - 0.01,
    );
    const capSvc = new AgentService({ storage: capRun.storage, playbooks, sandbox: true });
    const capNode = capCompiled.spec.nodes.find((n) => n.budget.maxCostGbp > 0.01);
    const capped = capNode
      ? await pauseReason(
          { ...capSvc.graphDeps, mode: "sandbox" },
          capRun.r.task,
          // A graph whose own budget is above the sandbox cap, so the cap is what stops it.
          { ...capCompiled, spec: { ...capCompiled.spec, budgetGbp: 10 } },
          capRun.r.report.runId,
          capNode,
        )
      : null;

    // 6. Probes: read-only, at most 5 nodes, no operator, and they share the per-graph sandbox cap.
    const lib = await libraryFor(capSvc);
    const outreach = await loadCompiled(
      capRun.storage,
      "pb-sme-outreach",
      capCompiled.spec.version,
    );
    const keep = new Set(["research", "draft", "check"]);
    const probeSpec = {
      ...outreach.spec,
      nodes: outreach.spec.nodes.filter((n) => keep.has(n.id)),
      edges: outreach.spec.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
      exits: ["check"],
    };
    const goodProbe = checkProbe(probeSpec, lib, policy);
    const badProbe = checkProbe(outreach.spec, lib, policy);
    const cap = policy.sandbox.max_cost_per_graph_gbp;
    const capOk = sandboxCapReason(cap - 1, 0.5, policy) === null;
    const capHit = sandboxCapReason(cap - 0.1, 0.5, policy);

    // 7. A failed node is a recorded failure: the task fails with the reason and Archie is alerted.
    const toolErrors = results.filter((x) => /tool error/.test(x.r.report.scenario));
    const failureRecords = await Promise.all(
      toolErrors.map(async ({ storage, r }) => ({
        status: r.task.status,
        error: r.task.error,
        alerted: (await storage.alerts.list({ limit: 50 })).some((a) => a.kind === "graph_failed"),
      })),
    );

    const allReports = results.map((x) => x.r.report);
    const criteria: GateCriterion[] = [
      {
        criterion:
          "Isolation: a sandbox refuses every live port, runs every external tool dry with no key even with every kill switch off, and makes no network call",
        status:
          refused.length === live.length &&
          inSandbox.seen.length === inSandbox.externals.length &&
          inSandbox.seen.every((c) => c.dryRun && !c.keys) &&
          outside.seen.some((c) => !c.dryRun) &&
          fetches.length === 0
            ? "passed (synthetic)"
            : "failed",
        evidence: `${refused.length}/${live.length} live ports refused (${refused.map(([p]) => p).join(", ")}); ${inSandbox.seen.length} external tools called with all switches off: ${inSandbox.seen.filter((c) => c.dryRun).length} ran dry, ${inSandbox.seen.filter((c) => c.keys).length} got a key (outside the sandbox the same calls ran live: ${outside.seen.filter((c) => !c.dryRun).length}); network calls during the whole gate: ${fetches.length}`,
      },
      {
        criterion:
          "Every converted playbook has sandbox reports with per-node cost: the happy path and at least one failure scenario",
        status: byPb.every(
          (b) =>
            b.happy?.r.report.pass &&
            b.happy.r.report.nodes.length > 0 &&
            b.failures.length >= policy.sandbox.min_failure_scenarios &&
            b.failures.every((f) => f.r.report.pass),
        )
          ? "passed (synthetic)"
          : "failed",
        evidence: byPb
          .map(
            (b) =>
              `${b.pb}: happy ${b.happy?.r.task.status} (${b.happy?.r.report.nodes.map((n) => `${n.nodeId} £${n.costGbp.toFixed(5)}`).join(", ")}; projected live £${b.happy?.r.report.totals.projectedLiveCostGbp.toFixed(5)}); ${b.failures.map((f) => `${f.r.report.scenario} → ${f.r.task.status}${f.r.report.pass ? "" : " FAILED"}`).join(", ")}`,
          )
          .join(" · "),
      },
      {
        criterion: "Sandbox spend never appears as live spend",
        status:
          totalEvents > 0 &&
          spend.every(
            (x) =>
              x.modes.every((m) => m === "sandbox") &&
              x.live === 0 &&
              x.runMode === "sandbox" &&
              x.synthetic &&
              x.dailyAlerts === 0,
          )
            ? "passed (synthetic)"
            : "failed",
        evidence: `${results.length} sandbox runs, ${totalEvents} cost events, every one mode "sandbox"; live cost events: ${spend.reduce((a, x) => a + x.live, 0)}; every graph run mode "sandbox" and every task synthetic; daily live-cap alerts raised: ${spend.reduce((a, x) => a + x.dailyAlerts, 0)}`,
      },
      {
        criterion:
          "A sandbox run pauses before a node that would cross the per-attempt sandbox cap",
        status: capped && /sandbox cap/.test(capped) ? "passed (synthetic)" : "failed",
        evidence: `a graph budgeted at £10 (above the cap), £${(policy.sandbox.max_cost_per_attempt_gbp - 0.01).toFixed(2)} spent, before ${capNode?.id} (worst case £${capNode?.budget.maxCostGbp.toFixed(2)}): "${capped}"`,
      },
      {
        criterion:
          "Probes: at most 5 nodes, read-only, no operator, no external tools; their cost counts against the per-graph sandbox cap",
        status:
          goodProbe.length === 0 && badProbe.length >= 3 && capOk && capHit
            ? "passed (synthetic)"
            : "failed",
        evidence: `research → draft → check from sme_outreach is a valid probe; the full graph is refused (${badProbe.map((e) => `${e.nodeId ?? "graph"}: ${e.message}`).join("; ")}); £${(cap - 0.1).toFixed(2)} spent + £0.50 next: "${capHit}"`,
      },
      {
        criterion:
          "A node that fails ends the run as a recorded failure, with the reason, and alerts Archie",
        status:
          failureRecords.length > 0 &&
          failureRecords.every((f) => f.status === "failed" && f.error && f.alerted)
            ? "passed (synthetic)"
            : "failed",
        evidence: failureRecords
          .map((f) => `${f.status}: "${f.error}"; alert ${f.alerted ? "raised" : "MISSING"}`)
          .join(" · "),
      },
      {
        criterion: `Every sandbox report carries "${SANDBOX_NOTE}" and says which model it used`,
        status: allReports.every((r) => r.note === SANDBOX_NOTE && r.model === "fake")
          ? "passed (synthetic)"
          : "failed",
        evidence: `${allReports.length} reports, all with the note; model: fake (the Anthropic key isn't readable from this session, so real-model costs come from your deployment; projected live cost prices the fake model's reported tokens at the current price table)`,
      },
    ];
    return { criteria, reports: allReports };
  } finally {
    globalThis.fetch = realFetch;
  }
}
