import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadDecisionsConfig, loadInfraConfig, loadKeysConfig, loadModelsConfig } from "@ae/config";
import {
  createTask,
  type DecisionDeps,
  expireDecisions,
  KeyFailedError,
  KeyRing,
  playbooksPausedByKeys,
  setKillSwitch,
  syncDecisions,
  ToolBlockedError,
} from "@ae/infra";
import { FakeKeyStore, type ModelClient, type ModelRequest } from "@ae/ports";
import { AnthropicModelClient } from "@ae/ports/anthropic";
import type { Storage } from "@ae/storage";
import { createApp } from "../app.ts";

/**
 * v3 Phase 5 gate (rule 20): keys are write-only, injected only at the tool-registry boundary, never reach
 * a model request, a log line, the database or brain/; a refused key raises one decision and pauses only
 * the playbooks that depend on it. Runs in a sandbox database with fake stores and a canary value.
 */
export async function runV3Phase5Gate(storage: Storage, root: string) {
  const CANARY = `sk-gate-canary-${crypto.randomUUID()}`;
  const SECOND = `sk-gate-second-${crypto.randomUUID()}`;
  const catalogue = loadKeysConfig();
  const emailDeps = catalogue.keys.find((k) => k.name === "EMAIL_API_KEY")?.playbooks ?? [];

  // Capture every log line for the whole run.
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const original = methods.map((m) => console[m]);
  for (const m of methods)
    console[m] = (...a: unknown[]) => {
      logged.push(
        a
          .map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x)))
          .join(" "),
      );
    };

  // Capture every model request.
  const requests: ModelRequest[] = [];
  const inner = fakeModel();
  const model: ModelClient = {
    name: inner.name,
    complete: (r) => {
      requests.push(r);
      return inner.complete(r);
    },
  };

  // A small synthetic world, so a real playbook run calls the model.
  await buildSyntheticWorld(storage, inner, { count: 60 });
  const entities = [
    ...new Set(
      (await storage.facts.listCurrent({ status: "verified", limit: 200, offset: 0 })).rows.map(
        (f) => f.entity_id,
      ),
    ),
  ];
  const entity = entities[0] as string;
  const store = new FakeKeyStore();
  const ring = new KeyRing(store, storage);
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    keys: ring,
  });
  const app = createApp({ runtime: "node", storage: () => storage, keys: () => store });
  const responses: string[] = [];
  const call = async (path: string, init?: RequestInit) => {
    const r = await app.request(path, init);
    const text = await r.text();
    responses.push(text);
    return {
      status: r.status,
      body: JSON.parse(text) as Record<string, unknown>,
      headers: r.headers,
    };
  };
  const put = (name: string, value: string) =>
    call(`/api/keys/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });

  try {
    // 1. Write-only.
    const saved = await put("EMAIL_API_KEY", CANARY);
    const unknown = await put("NOT_A_KEY", CANARY);
    const tooShort = await put("CH_API_KEY", "abc");
    const list = await call("/api/keys");
    const keys = list.body.keys as {
      name: string;
      status: string;
      saved: boolean;
      playbooks: string[];
    }[];
    const email = keys.find((k) => k.name === "EMAIL_API_KEY");

    // 2. Injection at the boundary (live calls only), and scrubbing on the way out.
    await setKillSwitch(storage, "global", false, "gate");
    const seen: { tool: string; keys: string[]; dryRun: boolean }[] = [];
    const reg = (
      name: string,
      keysNeeded: string[] | undefined,
      behave: "echo" | "refuse" | "plain",
    ) =>
      service.tools.register(
        {
          name,
          description: "gate tool",
          allowed_lanes: ["open"],
          external: true,
          serves_customer: false,
          allowed_roles: ["operator"],
          rate_limit_per_min: 100,
          cost_gbp_per_call: 0,
          ...(keysNeeded ? { keys: keysNeeded } : {}),
        },
        async (_a, env) => {
          seen.push({ tool: name, keys: Object.keys(env.keys ?? {}), dryRun: env.dryRun });
          const v = env.keys?.EMAIL_API_KEY ?? "";
          if (behave === "refuse")
            throw new KeyFailedError("EMAIL_API_KEY", `401 Unauthorized: bad key ${v}`);
          return {
            result: behave === "echo" ? { echoed: v, nested: [`Bearer ${v}`] } : { ok: true },
          };
        },
      );
    reg("gate_send", ["EMAIL_API_KEY"], "echo");
    reg("gate_plain", undefined, "plain");
    reg("gate_refused", ["EMAIL_API_KEY"], "refuse");
    reg("gate_needs_ch", ["CH_API_KEY"], "plain");
    const playbooks = (service as unknown as { playbooks: Map<string, unknown> })
      .playbooks as Parameters<typeof createTask>[2];
    const mk = async (playbook: string, n: string, on = entity) =>
      (
        await createTask(storage, loadInfraConfig(), playbooks, service.queue, {
          idempotency_key: `gate5:${playbook}:${n}`,
          playbook,
          revenue_path: playbook === "human_report" ? "human_check" : "sme_outreach",
          source_ref: `opportunity:gate-${n}:entity:${on}`,
          lane: "open",
        })
      ).task;
    const outreachTask = await mk("sme_outreach", "a");
    const ctx = (tool: string, task = outreachTask) => ({
      task,
      role: "operator" as const,
      step_tools: [tool],
    });
    const live = await service.tools.call("gate_send", { to: "x" }, ctx("gate_send"));
    const plain = await service.tools.call("gate_plain", {}, ctx("gate_plain"));
    await setKillSwitch(storage, "global", true, "gate");
    const dry = await service.tools.call("gate_send", { to: "y" }, ctx("gate_send"));
    await setKillSwitch(storage, "global", false, "gate");

    // 5. A missing key is refused before anything happens.
    const effectsBefore = (await storage.effects.unresolved(1000)).length;
    const missing = await service.tools.call("gate_needs_ch", {}, ctx("gate_needs_ch")).then(
      () => "ran",
      (e: Error) => (e instanceof ToolBlockedError ? e.reason : `other: ${e.message}`),
    );
    const chRow = await storage.keyRegistry.get("CH_API_KEY");

    // 4. A refused key: failing, one decision, only dependants paused.
    const refused = await service.tools.call("gate_refused", {}, ctx("gate_refused")).then(
      () => "ran",
      (e: Error) => e.message,
    );
    const failingRow = await storage.keyRegistry.get("EMAIL_API_KEY");
    const paused = await playbooksPausedByKeys(storage);
    const afterRefusal = await service.tools.call("gate_send", { to: "z" }, ctx("gate_send")).then(
      () => "ran",
      (e: Error) => (e instanceof ToolBlockedError ? e.reason : e.message),
    );
    const effectsAfter = (await storage.effects.unresolved(1000)).length;
    const deps: DecisionDeps = { storage, cfg: loadInfraConfig(), dcfg: loadDecisionsConfig() };
    await syncDecisions(deps);
    await syncDecisions(deps);
    const keyDecisions = await storage.decisions.list({
      status: "open",
      type: "key_failing",
      limit: 10,
    });
    // The real runner: the dependant waits untouched; a playbook that doesn't use the key still runs.
    const letterTask = await mk("sme_letter", "b", entities[1] ?? entity);
    const pausedTask = await mk("sme_outreach", "c", entities[2] ?? entity);
    const ranByQueue = await service.runQueued(50).then(
      (ts) => ts.map((t) => t.task_id),
      () => [] as string[],
    );
    const direct = await service.runner.run(pausedTask.task_id);
    const letterRun = await service.runner.run(letterTask.task_id).then(
      (t) => t.status,
      (e: Error) => `stopped: ${e.message}`,
    );
    const pausedAfter = await storage.tasks.get(pausedTask.task_id);
    const letterAfter = await storage.tasks.get(letterTask.task_id);
    const letterRan = (await storage.runLog.forTask(letterTask.task_id)).length > 0;
    // Expiry keeps them paused and is never Archie's approval.
    const approvalsBefore = (await storage.ownerApprovals.list(1000)).length;
    await expireDecisions({ ...deps, now: () => new Date(Date.now() + 400 * 3_600_000) });
    const expired = keyDecisions[0] ? await storage.decisions.get(keyDecisions[0].id) : null;
    const stillPaused = (await playbooksPausedByKeys(storage)).has("sme_outreach");
    const approvalsAfter = (await storage.ownerApprovals.list(1000)).length;
    // Saving a new key resumes the dependants.
    await put("EMAIL_API_KEY", SECOND);
    const resumed = !(await playbooksPausedByKeys(storage)).has("sme_outreach");
    const live2 = await service.tools.call("gate_send", { to: "w" }, ctx("gate_send"));

    // 3. The real model client: the key is in the header only, never the request body.
    let modelHeader = "";
    let modelBody = "";
    const anthropic = new AnthropicModelClient(loadModelsConfig().roles, {
      apiKey: CANARY,
      fetch: (async (_u: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        // SDK 1.6.0 sends the key as "authorization: Bearer …" (x-api-key in other versions).
        modelHeader = h.get("x-api-key") ?? h.get("authorization")?.replace(/^Bearer /, "") ?? "";
        modelBody = String(init?.body ?? "");
        return Response.json({
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }) as typeof fetch,
    });
    await anthropic.complete({
      role: "writer",
      system: "s",
      user: "u",
      max_tokens: 10,
    } as ModelRequest);

    const allCalls = JSON.stringify(service.tools.calls);
    const dbHits = [
      ...(await storage.audit.tablesContaining(CANARY)),
      ...(await storage.audit.tablesContaining(SECOND)),
    ];
    const brainHits = walk(join(root, "brain")).filter((f) => {
      const t = readFileSync(f, "utf8");
      return t.includes(CANARY) || t.includes(SECOND);
    });
    const leakIn = (xs: string[]) => xs.some((x) => x.includes(CANARY) || x.includes(SECOND));

    const criteria: GateCriterion[] = [
      {
        criterion:
          "Keys are write-only: saved through the dashboard API, never returned; bad names and values refused",
        status:
          saved.status === 200 &&
          !leakIn([JSON.stringify(saved.body)]) &&
          unknown.status === 404 &&
          tooShort.status === 400 &&
          list.headers.get("cache-control") === "no-store" &&
          email?.saved === true &&
          email.status === "set" &&
          keys.length === catalogue.keys.length &&
          !leakIn(responses)
            ? "passed (synthetic)"
            : "failed",
        evidence: `${responses.length} API responses (save, list, refusals) and none contains the value; EMAIL_API_KEY shows "set"; ${keys.length} keys listed with their dependants; the table has no value column (static test)`,
      },
      {
        criterion:
          "Keys are injected only at the tool-registry boundary, only on live calls, and scrubbed on the way out",
        status:
          seen[0]?.keys.join() === "EMAIL_API_KEY" &&
          seen.find((s) => s.tool === "gate_plain")?.keys.length === 0 &&
          seen.find((s) => s.dryRun)?.keys.length === 0 &&
          !JSON.stringify(live.result).includes(CANARY) &&
          JSON.stringify(live.result).includes("[key removed]") &&
          plain.dry_run === false &&
          dry.dry_run === true &&
          !allCalls.includes(CANARY)
            ? "passed (synthetic)"
            : "failed",
        evidence: `a live call to a tool that declares EMAIL_API_KEY received it; a tool that declares none got nothing; a dry run got nothing; a tool that echoed the key returned "${JSON.stringify(live.result)}"; the call log holds no value. Only packages/infra/src/keys.ts reads keys (static test)`,
      },
      {
        criterion: "Leak test: no key value in a model request, a log line, the database or brain/",
        status:
          requests.length > 0 &&
          !leakIn(requests.map((r) => JSON.stringify(r))) &&
          !leakIn(logged) &&
          dbHits.length === 0 &&
          brainHits.length === 0 &&
          modelHeader === CANARY &&
          !modelBody.includes(CANARY)
            ? "passed (synthetic)"
            : "failed",
        evidence: `${requests.length} model requests captured during a real playbook run, none with the value; ${logged.length} log lines, none with it; every database table scanned (0 hits); brain/ scanned (0 hits); the Claude client sends the key only in its auth header (body checked)`,
      },
      {
        criterion:
          "A refused key raises one decision and pauses only the playbooks that depend on it",
        status:
          /401/.test(refused) &&
          !refused.includes(CANARY) &&
          failingRow?.status === "failing" &&
          !failingRow.last_error?.includes(CANARY) &&
          [...paused.keys()].sort().join() === [...emailDeps].sort().join() &&
          /failing/.test(afterRefusal) &&
          effectsAfter === effectsBefore &&
          keyDecisions.length === 1 &&
          keyDecisions[0]?.safe_default === "keep_paused" &&
          pausedAfter?.status === "queued" &&
          direct.status === "queued" &&
          !ranByQueue.includes(pausedTask.task_id) &&
          letterRan &&
          letterAfter?.status !== "queued" &&
          expired?.status === "defaulted" &&
          stillPaused &&
          approvalsAfter === approvalsBefore &&
          resumed &&
          live2.dry_run === false
            ? "passed (synthetic)"
            : "failed",
        evidence: `the provider's 401 marked EMAIL_API_KEY failing (error kept, value removed); paused: ${[...paused.keys()].join(", ")} (exactly the key's dependants); the next call was refused before acting; one decision (safe default: keep paused); an sme_outreach task stayed queued while an sme_letter task ran (${letterAfter?.status}; ${letterRun}); the deadline defaulted without an approval; saving a new key resumed them`,
      },
      {
        criterion: "A missing key is refused before anything happens, and shows as not set",
        status:
          /isn't set/.test(missing) && chRow?.status === "unset" && effectsAfter === effectsBefore
            ? "passed (synthetic)"
            : "failed",
        evidence: `"${missing}"; no external action was recorded`,
      },
    ];
    return { criteria };
  } finally {
    methods.forEach((m, i) => {
      console[m] = original[i] as (typeof console)[typeof m];
    });
  }
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
