import {
  DurableObject,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  AgentService,
  fakeModel,
  handleJob,
  type Job,
  type JobRuntime,
  recordDeadLetter,
  scheduledJobs,
} from "@ae/agent-runner/runtime";
import {
  loadCompaniesHouseConfig,
  loadInfraConfig,
  loadModelsConfig,
  loadTriggersConfig,
} from "@ae/config";
import {
  BudgetBook,
  type BudgetPort,
  type ChangeFeedSource,
  chunkEvents,
  type FeedState,
  loadBundledPlaybooks,
  type ReserveResult,
  runFeedOnce,
  type ScopeLimit,
  WORKFLOWS,
  type WorkflowDef,
  workflowMayProceed,
} from "@ae/infra";
import { AnthropicModelClient } from "@ae/ports/anthropic";
import { liveRefresh } from "@ae/products";
import { createD1Storage, type Storage } from "@ae/storage";
import { CompaniesHouseClient, defaultContext } from "@ae/verification";

/**
 * The v2 runtime on Cloudflare (decision D3): Cron → Queue → consumer, a dead-letter queue, Workflows,
 * and the change-feed Durable Object. The same `handleJob` runs locally (apps/agent-runner).
 */
type Vars = Record<string, string | undefined>;

async function runtimeFor(env: Env): Promise<JobRuntime> {
  const vars = env as unknown as Vars;
  const storage = createD1Storage(env.DB);
  const models = loadModelsConfig();
  // The real model only when explicitly switched on (cutover); otherwise the deterministic fake.
  const model =
    vars.MODEL_LIVE === "1" && vars.ANTHROPIC_API_KEY
      ? new AnthropicModelClient(models.roles, { apiKey: vars.ANTHROPIC_API_KEY })
      : fakeModel();
  const service = new AgentService({
    storage,
    playbooks: await loadBundledPlaybooks(),
    model,
    budget: budgetPort(env),
    models,
  });
  const ch = loadCompaniesHouseConfig();
  const client = vars.CH_API_KEY
    ? new CompaniesHouseClient({ apiKey: vars.CH_API_KEY, config: ch })
    : null;
  return {
    service,
    send: async (job) => {
      await env.JOBS.send(job);
    },
    refresh: async (id) =>
      client ? liveRefresh(storage, defaultContext(), client, ch, id) : false,
  };
}

export async function scheduled(env: Env) {
  await env.JOBS.sendBatch(scheduledJobs().map((body) => ({ body })));
  await createD1Storage(env.DB).runtimeStatus.beat("cron", {
    jobs: scheduledJobs().map((j) => j.kind),
  });
  // Make sure the change feed's alarm is running (idempotent).
  const feed = env.CHANGE_FEED.getByName(
    "companies-house",
  ) as unknown as DurableObjectStub<ChangeFeed>;
  await feed.ensureRunning();
}

export async function queue(batch: MessageBatch<Job>, env: Env) {
  const storage = createD1Storage(env.DB);
  if (batch.queue === "ae-jobs-dlq") {
    for (const m of batch.messages) {
      await recordDeadLetter(storage, {
        queue: "ae-jobs",
        body: m.body,
        attempts: m.attempts,
        error: "failed after the queue's retries",
      });
      m.ack();
    }
    return;
  }
  const rt = await runtimeFor(env);
  for (const m of batch.messages) {
    try {
      await handleJob(rt, m.body);
      m.ack();
    } catch (e) {
      console.error("job failed", m.body?.kind, (e as Error).message);
      m.retry();
    }
  }
  await storage.runtimeStatus.beat("queue_consumer", { messages: batch.messages.length });
}

/**
 * The Companies House change feed. Holds the feed position (timepoint) in its own strongly consistent
 * storage and reads on an alarm. No source is configured yet (the streaming adapter waits for its
 * documentation to be checked), so it reports "not configured" and the cron's polling fallback runs.
 */
export class ChangeFeed extends DurableObject<Env> {
  private source(): ChangeFeedSource | null {
    return null;
  }

  async ensureRunning() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  override async alarm() {
    const storage = createD1Storage(this.env.DB);
    const source = this.source();
    if (!source) {
      await storage.runtimeStatus.beat("change_feed", { configured: false, last_event_at: null });
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
      return;
    }
    const state = ((await this.ctx.storage.get<FeedState>("state")) ?? {
      timepoint: null,
      last_event_at: null,
      last_read_at: null,
    }) as FeedState;
    const next = await runFeedOnce(
      source,
      state,
      async (events) => {
        for (const batch of chunkEvents(events, loadTriggersConfig()))
          await this.env.JOBS.send({ kind: "company_events", source: source.name, events: batch });
      },
      { budgetMs: 20_000 },
    );
    await this.ctx.storage.put("state", next);
    await storage.runtimeStatus.beat("change_feed", { configured: true, ...next });
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }
}

interface EngineParams {
  workflow: string;
  params: unknown;
  instance_id: string;
}

/**
 * Adapter from Cloudflare Workflows to the engine's step contract. Live instances check the kill switch
 * before each step and wait (sleeping, re-checking every 5 minutes) while it's on.
 */
export class EngineWorkflow extends WorkflowEntrypoint<Env, EngineParams> {
  override async run(event: WorkflowEvent<EngineParams>, step: WorkflowStep) {
    const { workflow, params, instance_id } = event.payload;
    const def = WORKFLOWS.find((w) => w.name === workflow) as
      | WorkflowDef<unknown, unknown>
      | undefined;
    if (!def) throw new Error(`unknown workflow ${workflow}`);
    const storage: Storage = createD1Storage(this.env.DB);
    const cfg = loadInfraConfig();
    const inst = await step.do("load instance", async () => {
      const i = await storage.workflows.get(instance_id);
      return { playbook: i?.playbook ?? def.playbook, dry_run: i?.dry_run ?? true };
    });
    const out = await def.run(
      params,
      {
        do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
          for (let i = 0; ; i++) {
            const ok = await step.do(`kill check: ${name} #${i}`, () =>
              workflowMayProceed(storage, cfg, inst),
            );
            if (ok) break;
            await step.do(`mark paused: ${name} #${i}`, async () => {
              await storage.workflows.update(instance_id, {
                status: "paused",
                pause_reason: "kill switch on",
              });
              return true;
            });
            await step.sleep(`wait for kill switch: ${name} #${i}`, "5 minutes");
          }
          return (await step.do(name, async () => {
            const r = await fn();
            await storage.workflows.putStep(instance_id, name, r ?? null);
            return (r ?? null) as never;
          })) as T;
        },
        sleep: (name, ms) => step.sleep(name, ms),
      },
      { instanceId: instance_id, dryRun: inst.dry_run },
    );
    await step.do("complete", async () => {
      await storage.workflows.update(instance_id, { status: "complete", output: out ?? null });
      return true;
    });
    return out;
  }
}

/**
 * Hard budgets (v2 Phase 3). One Budget Durable Object holds every reservation. Its methods use the
 * SQLite-backed synchronous KV API, so each runs to completion before the next starts: parallel
 * reservations can't jointly exceed a cap.
 */
export class BudgetObject extends DurableObject<Env> {
  private book() {
    return new BudgetBook(this.ctx.storage.kv);
  }
  reserve(id: string, amount: number, scopes: ScopeLimit[]): ReserveResult {
    return this.book().reserve(id, amount, scopes);
  }
  settle(id: string, actual: number): { overrun: number } {
    return this.book().settle(id, actual);
  }
  release(id: string): void {
    this.book().release(id);
  }
}

export function budgetPort(env: Env): BudgetPort {
  const stub = () => env.BUDGET.getByName("global") as unknown as DurableObjectStub<BudgetObject>;
  return {
    reserve: async (id, amount, scopes) =>
      (await stub().reserve(id, amount, scopes)) as ReserveResult,
    settle: async (id, actual) => (await stub().settle(id, actual)) as { overrun: number },
    release: async (id) => {
      await stub().release(id);
    },
  };
}
