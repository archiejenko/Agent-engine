import {
  loadDecisionsConfig,
  loadTriggersConfig,
  loadUniverseConfig,
  type TriggersConfig,
} from "@ae/config";
import {
  type CompanyEvent,
  chunkEvents,
  dailyDigest,
  expireDecisions,
  feedIsStale,
  type GraphNodeJob,
  type LocalWorkflowEngine,
  loadTriggerScope,
  pollFallback,
  processEvents,
  runGraphNodeJob,
  syncDecisions,
  type WorkflowPort,
} from "@ae/infra";
import { explainOpportunity } from "@ae/opportunity";
import type { Storage } from "@ae/storage";
import type { AgentService } from "./service.ts";

/**
 * Jobs (v2 Phase 2). On Cloudflare a Cron Trigger enqueues jobs onto the `ae-jobs` queue and the queue
 * consumer runs them (failed messages are retried, then land on the dead-letter queue, which records
 * them and raises an alert). Locally the same `handleJob` runs from LocalJobQueue, which copies those
 * retry and dead-letter rules. Nothing here is Node-specific.
 */
export type Job =
  | { kind: "tick"; max?: number }
  | { kind: "company_events"; source: string; events: CompanyEvent[] }
  | { kind: "poll_fallback" }
  | { kind: "reverify"; entity_id: string; reason: string }
  | { kind: "workflows_tick" }
  | { kind: "decisions" }
  /** Task graph runtime (graph plan G2): run one role node, then wake its graph_run. */
  | GraphNodeJob;

export interface JobRuntime {
  service: AgentService;
  /** Sends a follow-on job (the queue on Cloudflare, the local queue otherwise). */
  send(job: Job): Promise<void>;
  /** Re-fetches one company from Companies House; false when it couldn't (no key, not found). */
  refresh(entityId: string): Promise<boolean>;
  workflows?: LocalWorkflowEngine | null;
  /** Telling workflows about decisions (claim publish); Cloudflare Workflows or the local engine. */
  workflowPort?: WorkflowPort;
  triggers?: TriggersConfig;
  now?: () => Date;
}

/** What the scheduled trigger enqueues on each run. */
export function scheduledJobs(): Job[] {
  return [
    { kind: "tick" },
    { kind: "poll_fallback" },
    { kind: "workflows_tick" },
    { kind: "decisions" },
  ];
}

export async function handleJob(rt: JobRuntime, job: Job): Promise<unknown> {
  const storage = rt.service.storage;
  const triggers = rt.triggers ?? loadTriggersConfig();
  const now = rt.now?.() ?? new Date();
  switch (job.kind) {
    case "tick": {
      const r = await rt.service.tick(job.max ?? 50);
      await storage.runtimeStatus.beat("tick", r);
      return r;
    }
    case "company_events": {
      const scope = await loadTriggerScope(storage, loadUniverseConfig().name);
      const r = await processEvents(
        storage,
        triggers,
        job.events,
        scope,
        {
          reverify: (entity_id, reason) => rt.send({ kind: "reverify", entity_id, reason }),
          alert: async (message, details) => {
            await storage.alerts.raise("trigger", message, details);
          },
          explain: (entityId) => reexplain(rt.service, storage, entityId),
        },
        now,
      );
      await storage.runtimeStatus.beat(`events:${job.source}`, {
        events: r.events,
        matched: r.matched,
        model_calls: r.model_calls,
      });
      return r;
    }
    case "poll_fallback": {
      const feed = (await storage.runtimeStatus.all()).find((s) => s.name === "change_feed");
      if (!feedIsStale(feed, triggers, now)) return { skipped: "change feed is healthy" };
      const r = await pollFallback(storage, rt.service.ctx, triggers, rt.refresh, now);
      await storage.runtimeStatus.beat("poll_fallback", {
        polled: r.polled,
        events: r.events.length,
      });
      for (const events of chunkEvents(r.events, triggers))
        await rt.send({ kind: "company_events", source: "poll", events });
      return r;
    }
    case "reverify":
      return rt.refresh(job.entity_id);
    case "workflows_tick":
      return rt.workflows ? rt.workflows.tick() : 0;
    case "graph_node":
      return runGraphNodeJob(rt.service.graphDeps, job, rt.workflowPort ?? rt.service.workflowPort);
    case "decisions": {
      // Sync the Needs-you queue, apply safe defaults to expired decisions, build yesterday's digest.
      const d = {
        storage,
        cfg: rt.service.infra,
        dcfg: loadDecisionsConfig(),
        decideTask: (id: string, x: "approve" | "edit" | "reject", t: string | null) =>
          rt.service.decide(id, x, t),
        ...(rt.workflowPort ? { workflows: rt.workflowPort } : {}),
      };
      const opened = await syncDecisions(d);
      const defaulted = await expireDecisions(d);
      const digest = await dailyDigest(storage, rt.service.infra, d.dcfg, now);
      await storage.runtimeStatus.beat("decisions", {
        opened,
        defaulted,
        digest: digest?.day ?? null,
      });
      return { opened, defaulted };
    }
  }
}

/** Re-explains the company's open lead with the model (the one trigger action that calls it). */
async function reexplain(service: AgentService, storage: Storage, entityId: string) {
  const opps = (await storage.opportunities.list({ status: "proposed", limit: 100_000 })).filter(
    (o) => o.entity_id === entityId,
  );
  for (const o of opps.slice(0, 1)) {
    const r = await explainOpportunity(service.model, o);
    await storage.opportunities.setRationale(o.opportunity_id, r.rationale);
  }
}

/** A message that failed max_retries times: kept for a person to look at, and an alert raised. */
export async function recordDeadLetter(
  storage: Storage,
  d: { queue: string; body: unknown; attempts: number; error: string | null },
) {
  const id = await storage.deadLetters.add(d);
  await storage.alerts.raise(
    "dead_letter",
    `A ${(d.body as { kind?: string })?.kind ?? "job"} failed ${d.attempts} times and was set aside (${d.error ?? "no error text"}).`,
    { dead_letter_id: id, queue: d.queue },
  );
  return id;
}

/**
 * Local stand-in for Cloudflare Queues with the same delivery rules: each message is retried up to
 * `maxRetries` times, then goes to the dead-letter handler. Jobs sent while draining run in the same drain.
 */
export class LocalJobQueue {
  private readonly items: { job: Job; attempts: number; error: string | null }[] = [];
  constructor(
    private readonly handler: (job: Job) => Promise<unknown>,
    private readonly onDead: (job: Job, attempts: number, error: string | null) => Promise<unknown>,
    private readonly maxRetries = 3,
  ) {}
  async send(job: Job) {
    this.items.push({ job, attempts: 0, error: null });
  }
  get size() {
    return this.items.length;
  }
  async drain(limit = 10_000): Promise<number> {
    let n = 0;
    while (this.items.length && n < limit) {
      const m = this.items.shift() as (typeof this.items)[number];
      n++;
      try {
        await this.handler(m.job);
      } catch (e) {
        m.attempts++;
        m.error = (e as Error).message;
        if (m.attempts > this.maxRetries) await this.onDead(m.job, m.attempts, m.error);
        else this.items.push(m);
      }
    }
    return n;
  }
}
