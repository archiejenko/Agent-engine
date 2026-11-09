import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type InfraConfig,
  loadInfraConfig,
  loadModelsConfig,
  loadProductsConfig,
  type ModelsConfig,
} from "@ae/config";
import {
  createPrintBatch,
  createTask,
  fakeLetterWriter,
  fakeOutreachWriter,
  type LoadedPlaybook,
  letterSuppressionKey,
  type PlaybookImpl,
  PlaybookRunner,
  parsePlaybook,
  processInbox,
  QUEUE_ORDER,
  recordBreach,
  registerLetterTools,
  registerOutreachTools,
  registerStandardTools,
  SME_LETTER,
  SME_OUTREACH,
  ToolRegistry,
} from "@ae/infra";
import { fakeExplainer, moduleStatus } from "@ae/opportunity";
import {
  type AlertChannel,
  type EmailSender,
  FakeAlertChannel,
  FakeEmailSender,
  FakeInbox,
  FakeModel,
  FakeWebFetcher,
  type Inbox,
  InMemoryQueue,
  type ModelClient,
  type QueueBus,
  type WebFetcher,
} from "@ae/ports";
import {
  HUMAN_REPORT,
  MONITORING_SUBSCRIPTION,
  queueAlerts,
  registerProductTools,
  WATCH_ALERT,
} from "@ae/products";
import type { Storage, StoredTask } from "@ae/storage";
import {
  defaultContext,
  fakeWebsiteExtractor,
  getVerifiedFacts,
  type VerificationContext,
} from "@ae/verification";

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

export const PLAYBOOK_IMPLS = new Map<string, PlaybookImpl>([
  ["sme_outreach", SME_OUTREACH],
  ["sme_letter", SME_LETTER],
  ["human_report", HUMAN_REPORT],
  ["watch_alert", WATCH_ALERT],
  ["monitoring_subscription", MONITORING_SUBSCRIPTION],
]);

/** The deterministic fake model used everywhere until cutover. */
export function fakeModel(): FakeModel {
  return new FakeModel({
    website_extract: fakeWebsiteExtractor,
    opportunity_explain: fakeExplainer,
    sme_outreach_draft: fakeOutreachWriter,
    sme_letter_draft: fakeLetterWriter,
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
  email?: EmailSender;
  alerts?: AlertChannel;
  inbox?: Inbox;
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
  readonly email: EmailSender;
  readonly alerts: AlertChannel;
  readonly inbox: Inbox;
  readonly ctx: VerificationContext;

  constructor(d: ServiceDeps) {
    this.storage = d.storage;
    this.infra = d.infra ?? loadInfraConfig();
    this.queue = d.queue ?? new InMemoryQueue();
    this.playbooks = d.playbooks;
    this.model = d.model ?? fakeModel();
    this.tools = new ToolRegistry(d.storage, this.infra);
    const ctx = d.ctx ?? defaultContext();
    this.ctx = ctx;
    this.email = d.email ?? new FakeEmailSender();
    this.alerts = d.alerts ?? new FakeAlertChannel();
    this.inbox = d.inbox ?? new FakeInbox();
    registerStandardTools(this.tools, {
      storage: d.storage,
      ctx,
      fetcher: d.fetcher ?? new FakeWebFetcher(new Map()),
    });
    registerOutreachTools(this.tools, { storage: d.storage, cfg: this.infra, email: this.email });
    registerLetterTools(this.tools, { storage: d.storage, cfg: this.infra });
    registerProductTools(this.tools, {
      storage: d.storage,
      ctx,
      email: this.email,
      alerts: this.alerts,
      infra: this.infra,
      products: loadProductsConfig(),
    });
    // Any guardrail breach is recorded and auto-demotes the playbook one level.
    this.tools.onBreach = (b) =>
      recordBreach(d.storage, { ...b, base: d.playbooks.get(b.playbook)?.spec.autonomy ?? "L0" });
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
      let playbook = this.infra.playbook_for_module[o.module];
      if (!playbook) continue;
      // Leads we can't email (no website, or no emailable address) get a letter instead.
      if (
        this.infra.letters.fallback_for.includes(playbook) &&
        !(await this.emailable(o.entity_id))
      )
        playbook = this.infra.letters.playbook;
      if (
        playbook === this.infra.letters.playbook &&
        (await this.storage.suppressions.isSuppressed(letterSuppressionKey(o.entity_id)))
      ) {
        await this.storage.opportunities.setStatus(o.opportunity_id, "actioned");
        continue; // asked not to receive letters
      }
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

  /**
   * Can we email this company within the outreach rules? A verified role address from its own website
   * and a corporate company type (anything else needs prior consent). Routing only, not a claim.
   */
  async emailable(entityId: string): Promise<boolean> {
    const facts = await getVerifiedFacts(this.storage, this.ctx, {
      entities: [entityId],
      fields: ["contact_email", "company_type"],
      minConfidence: 0,
      asOf: new Date().toISOString(),
      lanes: ["open"],
      caller: "playbook",
    });
    const email = facts.find((f) => f.field === "contact_email" && f.status === "verified");
    const type = facts.find((f) => f.field === "company_type")?.value;
    return (
      Boolean(email) &&
      typeof type === "string" &&
      this.infra.outreach.corporate_company_types.includes(type)
    );
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

  /** Due follow-ups → new outreach tasks (each still needs its own approval at L1). */
  async processFollowups(now = new Date()): Promise<number> {
    let created = 0;
    for (const f of await this.storage.followups.due(now.toISOString())) {
      const opp = f.opportunity_id;
      const r = await createTask(this.storage, this.infra, this.playbooks, this.queue, {
        idempotency_key: `followup:${f.thread_id}:${f.attempt}`,
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: opp
          ? `opportunity:${opp}:entity:${f.entity_id}`
          : `followup:${f.thread_id}:entity:${f.entity_id}`,
        lane: "open",
        state: { followup: { thread_id: f.thread_id, attempt: f.attempt } },
      });
      await this.storage.followups.mark(f.thread_id, f.attempt, "created");
      if (r.created) created++;
    }
    return created;
  }

  async tick(max = 50) {
    const now = new Date();
    const lastCheck =
      (await this.storage.controls.get<string>("watch:last_check")) ?? "1970-01-01T00:00:00Z";
    const alerts = await queueAlerts(
      this.storage,
      this.infra,
      this.playbooks,
      this.queue,
      lastCheck,
    );
    await this.storage.controls.set("watch:last_check", now.toISOString(), "runner");
    const lastInbox =
      (await this.storage.controls.get<string>("inbox:last_poll")) ?? "1970-01-01T00:00:00Z";
    const inbox = await processInbox(this.storage, this.infra, this.inbox, lastInbox);
    await this.storage.controls.set("inbox:last_poll", now.toISOString(), "runner");
    const followups = await this.processFollowups(now);
    const intake = await this.intakeApproved();
    const decisions = await this.applyPendingDecisions();
    const ran = await this.runQueued(max);
    const timedOut = await this.runner.timeoutStuck();
    // Weekly print batch of prepared letters (at most one per batch_every_days).
    const batch = await createPrintBatch(this.storage, this.infra, { now });
    return {
      intake,
      decisions,
      ran: ran.length,
      timed_out: timedOut,
      alerts,
      inbox,
      followups,
      print_batch: batch?.id ?? null,
    };
  }
}
