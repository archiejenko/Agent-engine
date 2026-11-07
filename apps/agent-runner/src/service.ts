import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type InfraConfig, loadInfraConfig, loadModelsConfig, type ModelsConfig } from "@ae/config";
import {
  createTask,
  fakeOutreachWriter,
  type LoadedPlaybook,
  type PlaybookImpl,
  PlaybookRunner,
  parsePlaybook,
  QUEUE_ORDER,
  registerStandardTools,
  SME_OUTREACH,
  ToolRegistry,
} from "@ae/infra";
import { fakeExplainer, moduleStatus } from "@ae/opportunity";
import {
  FakeModel,
  FakeWebFetcher,
  InMemoryQueue,
  type ModelClient,
  type QueueBus,
  type WebFetcher,
} from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { defaultContext, fakeWebsiteExtractor, type VerificationContext } from "@ae/verification";

/** Load every playbooks/<name>/SKILL.md. */
export async function loadPlaybooks(dir: string): Promise<Map<string, LoadedPlaybook>> {
  const out = new Map<string, LoadedPlaybook>();
  for (const name of readdirSync(dir)) {
    try {
      const pb = await parsePlaybook(readFileSync(join(dir, name, "SKILL.md"), "utf8"));
      out.set(pb.spec.playbook, pb);
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOTDIR" &&
        (e as NodeJS.ErrnoException).code !== "ENOENT"
      )
        throw e;
    }
  }
  return out;
}

export const PLAYBOOK_IMPLS = new Map<string, PlaybookImpl>([["sme_outreach", SME_OUTREACH]]);

/** The deterministic fake model used everywhere until cutover. */
export function fakeModel(): FakeModel {
  return new FakeModel({
    website_extract: fakeWebsiteExtractor,
    opportunity_explain: fakeExplainer,
    sme_outreach_draft: fakeOutreachWriter,
  });
}

export interface ServiceDeps {
  storage: Storage;
  playbooks: Map<string, LoadedPlaybook>;
  model?: ModelClient;
  fetcher?: WebFetcher;
  queue?: QueueBus;
  ctx?: VerificationContext;
  infra?: InfraConfig;
  models?: ModelsConfig;
  impls?: Map<string, PlaybookImpl>;
  now?: () => Date;
}

/**
 * The agent runner service. One tick: approved leads → tasks; Archie's dashboard decisions → applied;
 * queued tasks → run (customer work first); stuck tasks → timed out.
 */
export class AgentService {
  readonly storage: Storage;
  readonly infra: InfraConfig;
  readonly queue: QueueBus;
  readonly runner: PlaybookRunner;
  readonly playbooks: Map<string, LoadedPlaybook>;
  readonly tools: ToolRegistry;
  readonly model: ModelClient;

  constructor(d: ServiceDeps) {
    this.storage = d.storage;
    this.infra = d.infra ?? loadInfraConfig();
    this.queue = d.queue ?? new InMemoryQueue();
    this.playbooks = d.playbooks;
    this.model = d.model ?? fakeModel();
    this.tools = new ToolRegistry(d.storage, this.infra);
    registerStandardTools(this.tools, {
      storage: d.storage,
      ctx: d.ctx ?? defaultContext(),
      fetcher: d.fetcher ?? new FakeWebFetcher(new Map()),
    });
    this.runner = new PlaybookRunner({
      storage: d.storage,
      infra: this.infra,
      models: d.models ?? loadModelsConfig(),
      model: this.model,
      tools: this.tools,
      playbooks: d.playbooks,
      impls: d.impls ?? PLAYBOOK_IMPLS,
      ...(d.now ? { now: d.now } : {}),
    });
  }

  /** Approved opportunities become tasks (idempotent on the opportunity id). */
  async intakeApproved(): Promise<number> {
    const approved = await this.storage.opportunities.list({ status: "approved", limit: 500 });
    let created = 0;
    const pilotUsed = new Map<string, number>();
    for (const o of approved) {
      // Pilot modules (no backtest ≥ 3× lift yet) are capped per week; live modules aren't.
      if ((await moduleStatus(this.storage, o.module)) === "pilot") {
        if (!pilotUsed.has(o.module)) {
          const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
          const recent = (
            await this.storage.opportunities.list({
              module: o.module,
              status: "actioned",
              limit: 100_000,
            })
          ).filter((x) => (x.decided_at ?? "") >= weekAgo);
          pilotUsed.set(o.module, recent.length);
        }
        if ((pilotUsed.get(o.module) as number) >= this.infra.modules.pilot_weekly_limit) {
          await this.storage.alerts.raise(
            "pilot_limit",
            `${o.module} is in pilot: weekly limit of ${this.infra.modules.pilot_weekly_limit} reached; ${o.opportunity_id} waits`,
            {},
          );
          continue;
        }
        pilotUsed.set(o.module, (pilotUsed.get(o.module) as number) + 1);
      }
      const playbook = this.infra.playbook_for_module[o.module];
      if (!playbook) continue;
      const pb = this.playbooks.get(playbook);
      if (!pb) continue;
      const r = await createTask(this.storage, this.infra, this.playbooks, this.queue, {
        idempotency_key: `opportunity:${o.opportunity_id}`,
        playbook,
        revenue_path: pb.spec.revenue_path,
        source_ref: `opportunity:${o.opportunity_id}:entity:${o.entity_id}`,
        lane: o.lane,
      });
      if (r.created) created++;
      await this.storage.opportunities.setStatus(o.opportunity_id, "actioned");
    }
    return created;
  }

  /** Decisions recorded by the dashboard API (which can't run playbooks itself). */
  async applyPendingDecisions(): Promise<number> {
    const waiting = await this.storage.tasks.list({ status: "awaiting_approval", limit: 500 });
    let n = 0;
    for (const t of waiting) {
      const pd = (
        t.state as {
          pending_decision?: {
            decision: "approve" | "edit" | "reject";
            edited_text: string | null;
          };
        }
      ).pending_decision;
      if (!pd) continue;
      const state = { ...(t.state as Record<string, unknown>) };
      delete state.pending_decision;
      await this.storage.tasks.update(t.task_id, { state });
      await this.runner.decide(t.task_id, pd.decision, pd.edited_text);
      n++;
    }
    return n;
  }

  async decide(taskId: string, decision: "approve" | "edit" | "reject", editedText: string | null) {
    return this.runner.decide(taskId, decision, editedText);
  }

  /** Run queued tasks, customer-waiting first. Uses the queue, falling back to the tasks table. */
  async runQueued(max = 50): Promise<StoredTask[]> {
    const done: StoredTask[] = [];
    const queued = await this.storage.tasks.list({ status: "queued", limit: 5000, order: "asc" });
    const rank = (p: string) => QUEUE_ORDER.indexOf(p as (typeof QUEUE_ORDER)[number]);
    for (const t of queued.sort((a, b) => rank(a.priority) - rank(b.priority)).slice(0, max)) {
      done.push(await this.runner.run(t.task_id));
    }
    for (const q of QUEUE_ORDER) await this.queue.receive(q, 10_000); // drained: the table is the source of truth locally
    return done;
  }

  async tick(max = 50) {
    const intake = await this.intakeApproved();
    const decisions = await this.applyPendingDecisions();
    const ran = await this.runQueued(max);
    const timedOut = await this.runner.timeoutStuck();
    return { intake, decisions, ran: ran.length, timed_out: timedOut };
  }
}
