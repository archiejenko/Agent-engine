import type { InfraConfig } from "@ae/config";
import { type Lane, type TaskInput, TaskInput as TaskInputSchema } from "@ae/contracts";
import type { QueueBus } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { playbookAutonomy } from "./controls.ts";
import type { LoadedPlaybook } from "./playbook.ts";

/**
 * createTask: the one door for all work (approved opportunities, x402 payments, Stripe webhooks,
 * cron). Idempotent on idempotency_key. Autonomy comes from the playbook (or its promoted level),
 * never from the caller. Routed to a queue by priority band; queue name = band.
 */
export async function createTask(
  storage: Storage,
  cfg: InfraConfig,
  playbooks: Map<string, LoadedPlaybook>,
  queue: QueueBus,
  input: TaskInput & { state?: Record<string, unknown> },
): Promise<{ task: StoredTask; created: boolean }> {
  const i = TaskInputSchema.parse(input);
  const pb = playbooks.get(i.playbook);
  if (!pb) throw new Error(`unknown playbook ${i.playbook}`);
  if (pb.spec.revenue_path !== i.revenue_path)
    throw new Error(`playbook ${i.playbook} serves ${pb.spec.revenue_path}, not ${i.revenue_path}`);
  const priority = cfg.priority_by_revenue_path[i.revenue_path] ?? "internal";
  const task_id = crypto.randomUUID();
  const stored = await storage.tasks.insertIdempotent({
    task_id,
    idempotency_key: i.idempotency_key,
    playbook: i.playbook,
    playbook_version: pb.spec.version,
    revenue_path: i.revenue_path,
    source_ref: i.source_ref,
    lane: i.lane as Lane,
    autonomy: await playbookAutonomy(storage, i.playbook, pb.spec.autonomy),
    status: "queued",
    budget_gbp: pb.spec.budget_gbp,
    revenue_gbp: 0,
    cost_gbp: 0,
    priority,
    state: input.state ?? {},
  });
  const created = stored.task_id === task_id;
  if (created) await queue.send(priority, { task_id });
  return { task: stored, created };
}

/** Customer-waiting work first, then approved outreach, then internal jobs. */
export const QUEUE_ORDER = ["customer", "outreach", "internal"] as const;

export async function nextTaskIds(queue: QueueBus, max: number): Promise<string[]> {
  const out: string[] = [];
  for (const q of QUEUE_ORDER) {
    if (out.length >= max) break;
    const msgs = (await queue.receive(q, max - out.length)) as { task_id: string }[];
    out.push(...msgs.map((m) => m.task_id));
  }
  return out;
}
