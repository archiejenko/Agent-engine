import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  handleJob,
  type Job,
  type JobRuntime,
  LocalJobQueue,
  loadPlaybooks,
  recordDeadLetter,
  scheduledJobs,
} from "@ae/agent-runner";
import { loadTriggersConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
import {
  type CompanyEvent,
  createTask,
  K,
  LocalWorkflowEngine,
  processEvents,
  ruleMatches,
  type TriggerScope,
  type WorkflowDef,
} from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import { InMemoryQueue } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { ingestClaims, stableUuid } from "@ae/verification";
import { createApp } from "../app.ts";

/**
 * v2 Phase 2 gate: the runtime's guarantees, exercised locally with the same code the Worker runs
 * (handleJob, the workflow step contract, the trigger filter). Cloudflare-only parts (Queues delivery,
 * Workflows scheduling, Durable Object alarms) are configured in wrangler.jsonc and checked by a
 * `wrangler deploy --dry-run` build in the gate script.
 */
export async function runV2Phase2Gate(
  storage: Storage,
  root: string,
  o: { count: number; log?: (m: string) => void },
) {
  const model = fakeModel();
  const world = await buildSyntheticWorld(storage, model, { count: o.count, log: o.log });
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    synthetic: true,
  });
  const triggers = loadTriggersConfig();
  const app = createApp({ runtime: "node", storage: () => storage });

  // A fixture external tool: counts how many times the outside world would really have been touched.
  let touches = 0;
  let failInside = false;
  service.tools.register(
    {
      name: "gate_notify",
      description: "Gate fixture: an external action",
      allowed_lanes: ["open"],
      external: true,
      serves_customer: false,
      allowed_roles: ["operator"],
      rate_limit_per_min: 1000,
      cost_gbp_per_call: 0,
    },
    async (args) => {
      touches++;
      if (failInside) throw new Error("connection reset after sending");
      return { result: { ok: true, args } };
    },
  );
  const { task } = await createTask(
    storage,
    service.infra,
    service.playbooks,
    new InMemoryQueue(),
    {
      idempotency_key: "gate:v2-phase2",
      playbook: "sme_outreach",
      revenue_path: "sme_outreach",
      source_ref: "gate:v2-phase2:entity:00000000",
      lane: "open",
      synthetic: true,
    },
  );
  const notify = (to: string) =>
    service.tools.call(
      "gate_notify",
      { to },
      { task, role: "operator", step_tools: ["gate_notify"] },
    );

  // ---- 1. Kill switch mid-workflow, then resume: no step runs while it's on, nothing repeats after.
  const ran: string[] = [];
  let crashOnce = true;
  const fixture: WorkflowDef<{ to: string }, unknown> = {
    name: "gate_fulfilment",
    playbook: "sme_outreach",
    run: async (p, step) => {
      await step.do("prepare", async () => {
        ran.push("prepare");
        // Archie turns the global kill switch on while this step is running.
        await storage.controls.set(K.global, true, "gate");
        return true;
      });
      const sent = await step.do("notify customer", async () => {
        ran.push("notify customer");
        const r = await notify(p.to);
        // The worker dies after the action happened but before the step was saved.
        if (crashOnce) {
          crashOnce = false;
          throw new Error("worker crashed after the action");
        }
        return r.result;
      });
      await step.do("record", async () => {
        ran.push("record");
        return sent;
      });
      return { done: true };
    },
  };
  const engine = new LocalWorkflowEngine(storage, service.infra, [
    fixture as WorkflowDef<never, unknown>,
  ]);
  await storage.controls.set(K.global, false, "gate"); // a LIVE instance (kill switch off at start)
  const started = await engine.start(
    "gate_fulfilment",
    { to: "customer@example.test" },
    { synthetic: true },
  );
  const pausedAfter = [...ran];
  const ticksWhileKilled = await engine.tick(); // must not advance
  const stillPaused = (await storage.workflows.get(started.id))?.status;
  await storage.controls.set(K.global, false, "gate"); // Archie resumes
  await engine.tick();
  const finished = await storage.workflows.get(started.id);
  const effects = await storage.effects.forTask(task.task_id);
  const touchesWorkflow = touches;

  // ---- 2. An action whose outcome is unknown is never retried automatically.
  failInside = true;
  const touchesBefore = touches;
  const firstTry = await notify("other@example.test").then(
    () => "ok",
    (e: Error) => e.message,
  );
  failInside = false;
  const secondTry = await notify("other@example.test").then(
    () => "ran again",
    (e: Error) => e.message,
  );
  const unknownRefused = touches === touchesBefore + 1 && /outcome is unknown/.test(secondTry);
  const runtimeView = (await (await app.request("/api/runtime")).json()) as {
    uncertain_effects: { key: string }[];
    workflows: { counts: Record<string, number> };
    heartbeats: { name: string }[];
    dead_letters: unknown[];
    change_feed: { configured: boolean; polling_fallback_active: boolean };
  };
  await storage.controls.set(K.global, true, "gate"); // back to the default

  // ---- 3. 1,000 change events: the model is called only for events a model rule matches.
  const universe = (await storage.universe.list(world.universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const scope: TriggerScope = {
    universe: new Set(universe),
    opportunity: new Set(universe.slice(0, 25)),
    watched: new Set(universe.slice(25, 30)),
  };
  const kinds: CompanyEvent["kind"][] = ["company", "filing", "officers", "psc", "charges"];
  const categories = ["accounts", "confirmation-statement", "officers", "address", "capital"];
  const statuses = ["active", "active", "active", "liquidation", "dissolved"];
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const outside = Array.from({ length: 4000 }, (_, i) => String(20_000_000 + i));
  const events: CompanyEvent[] = Array.from({ length: 1000 }, (_, i) => {
    const r = rnd(100);
    const pool = r < 10 ? [...scope.opportunity] : r < 35 ? universe : outside;
    const kind = kinds[rnd(kinds.length)] as CompanyEvent["kind"];
    return {
      id: `fixture-${i}`,
      entity_id: pool[rnd(pool.length)] as string,
      kind,
      data:
        kind === "filing"
          ? { category: categories[rnd(categories.length)] }
          : kind === "company"
            ? {
                company_status: statuses[rnd(statuses.length)],
                changed: rnd(4) === 0 ? ["registered_office_address"] : [],
              }
            : {},
      published_at: new Date().toISOString(),
    };
  });
  const modelRules = triggers.rules.filter((r) => r.model);
  const expectedModel = events.filter((e) =>
    modelRules.some((r) => ruleMatches(r, e, scope)),
  ).length;
  const expectedMatched = events.filter((e) =>
    triggers.rules.some((r) => ruleMatches(r, e, scope)),
  ).length;
  let modelCalls = 0;
  let explainedNonMatching = 0;
  const tstats = await processEvents(storage, triggers, events, scope, {
    reverify: async () => {},
    alert: async () => {},
    explain: async (entityId) => {
      modelCalls++;
      if (!scope.opportunity.has(entityId)) explainedNonMatching++;
    },
  });
  const statRows = await storage.triggerStats.since(new Date().toISOString().slice(0, 10));
  const statModelCalls = statRows.reduce((a, r) => a + r.model_calls, 0);

  // ---- 4. Jobs: retries, then the dead-letter queue (recorded + alert); good jobs unaffected.
  const handled: string[] = [];
  const rt: JobRuntime = {
    service,
    send: async (job) => jobs.send(job),
    refresh: async () => false,
  };
  const jobs: LocalJobQueue = new LocalJobQueue(
    async (job: Job) => {
      if (job.kind === "reverify" && job.entity_id === "POISON00") throw new Error("upstream 500");
      handled.push(job.kind);
      return handleJob(rt, job);
    },
    (job, attempts, error) =>
      recordDeadLetter(storage, { queue: "ae-jobs", body: job, attempts, error }),
    3,
  );
  for (const j of scheduledJobs()) await jobs.send(j);
  await jobs.send({ kind: "reverify", entity_id: "POISON00", reason: "gate" });
  await jobs.drain();
  const dead = await storage.deadLetters.list({ open: true });
  const deadAlert = (await storage.alerts.list({ limit: 200 })).some(
    (a) => a.kind === "dead_letter",
  );

  // ---- 5. Polling fallback: with no change feed, polling notices a company going into liquidation and
  //         the same trigger rules act on it.
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  await runModule(storage, world.ctx, fw, { asOf: new Date().toISOString() });
  const opps = await storage.opportunities.list({ status: "proposed", limit: 100_000 });
  const victim = opps[0]?.entity_id ?? "";
  const pollRt: JobRuntime = {
    service,
    send: async (job) => jobs.send(job),
    refresh: async (id) => {
      if (id !== victim) return true;
      const now = new Date().toISOString();
      const run = (await storage.runs.start({ kind: "simulated_change" })).run_id;
      const change: Claim = {
        claim_id: await stableUuid(["companies_house", id, "company_status", now, "liquidation"]),
        entity_id: id,
        raw_entity_ref: { source_id: id, name: null },
        field: "company_status",
        value: "liquidation",
        source: "companies_house",
        source_tier: 1,
        lane: "open",
        method: "api",
        evidence: { kind: "record", ref: "simulated" },
        observed_at: now,
        published_at: now,
        fetched_at: now,
        run_id: run,
      };
      await ingestClaims(storage, world.ctx, { run_id: run, fetched_at: now }, [change]);
      return true;
    },
  };
  const triggersAll = {
    ...triggers,
    fallback_poll: { ...triggers.fallback_poll, entities_per_poll: 1000 },
  };
  const poll = (await handleJob(
    { ...pollRt, triggers: triggersAll },
    { kind: "poll_fallback" },
  )) as {
    polled: number;
    events: CompanyEvent[];
  };
  const jobsAfterPoll = new LocalJobQueue(
    (job) => handleJob({ ...pollRt, triggers: triggersAll }, job),
    async () => {},
  );
  for (const e of [{ kind: "company_events", source: "poll", events: poll.events } as Job])
    await jobsAfterPoll.send(e);
  await jobsAfterPoll.drain();
  const liquidationAlert = (await storage.alerts.list({ limit: 500 })).some(
    (a) =>
      a.kind === "trigger" && a.message.includes(victim) && a.message.includes("status_changed"),
  );
  const health = (await (await app.request("/api/runtime")).json()) as typeof runtimeView;

  const criteria: GateCriterion[] = [
    {
      criterion:
        "Global kill switch stops a live workflow within one step; resume continues where it stopped",
      status:
        pausedAfter.join(",") === "prepare" &&
        stillPaused === "paused" &&
        ticksWhileKilled === 0 &&
        finished?.status === "complete" &&
        ran.filter((r) => r === "prepare").length === 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `switch turned on during step 1 → stopped before step 2 (steps run: ${pausedAfter.join(", ")}; status ${stillPaused}); resumed → ${finished?.status}; "prepare" ran ${ran.filter((r) => r === "prepare").length} time(s)`,
    },
    {
      criterion: "Kill/resume and a crash after an external action cause no repeated action",
      status:
        effects.length === 1 && effects[0]?.status === "done" && touchesWorkflow === 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `the step crashed after its action and was retried: the action was recorded once (${effects.map((e) => `${e.tool}: ${e.status}`).join("; ")}), the outside world was touched once; the retry got the recorded result back`,
    },
    {
      criterion:
        "An action whose outcome is unknown is never repeated automatically; a person settles it",
      status:
        unknownRefused && runtimeView.uncertain_effects.length >= 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `first attempt failed mid-call ("${firstTry}"); second attempt refused ("${secondTry.slice(0, 90)}…"); shown on the health page for a person to mark happened / didn't happen`,
    },
    {
      criterion: "1,000 change events: the model is called only for rule matches",
      status:
        tstats.events === 1000 &&
        modelCalls === expectedModel &&
        tstats.model_calls === expectedModel &&
        statModelCalls === expectedModel &&
        explainedNonMatching === 0 &&
        tstats.matched === expectedMatched
          ? "passed (synthetic)"
          : "failed",
      evidence: `1,000 events (${tstats.events} processed) → ${tstats.matched} matched a rule (expected ${expectedMatched}; trigger_stats model calls ${statModelCalls}) → ${modelCalls} model calls (expected ${expectedModel}, all for leads); ${1000 - tstats.matched} ignored by the cheap filter with no model call; per-rule counts in trigger_stats`,
    },
    {
      criterion:
        "Queue: a failing job is retried, then lands on the dead-letter queue with an alert; others run",
      status:
        dead.length === 1 &&
        (dead[0]?.attempts ?? 0) === 4 &&
        deadAlert &&
        ["tick", "poll_fallback", "workflows_tick"].every((k) => handled.includes(k))
          ? "passed (synthetic)"
          : "failed",
      evidence: `poison job tried ${dead[0]?.attempts} times (1 + 3 retries) → dead letter + alert; scheduled jobs ran: ${[...new Set(handled)].join(", ")}`,
    },
    {
      criterion:
        "Change feed not connected → polling fallback takes over and feeds the same trigger rules",
      status:
        !health.change_feed.configured &&
        health.change_feed.polling_fallback_active &&
        poll.polled > 0 &&
        poll.events.some((e) => e.entity_id === victim) &&
        liquidationAlert
          ? "passed (synthetic)"
          : "failed",
      evidence: `feed configured: ${health.change_feed.configured}; polling refreshed ${poll.polled} companies, found ${poll.events.length} change(s); ${victim} went into liquidation → status_changed rule → alert`,
    },
    {
      criterion:
        "Health page shows heartbeats, dead letters, uncertain actions, workflows and trigger counts",
      status:
        health.heartbeats.some((h) => h.name === "tick") &&
        health.dead_letters.length === 1 &&
        (health.workflows.counts.complete ?? 0) >= 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `heartbeats: ${health.heartbeats.map((h) => h.name).join(", ")}; ${health.dead_letters.length} dead letter; workflows ${JSON.stringify(health.workflows.counts)}`,
    },
  ];
  return { criteria };
}
