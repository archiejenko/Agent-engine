import type { InfraConfig } from "@ae/config";
import type { Storage, StoredTask } from "@ae/storage";
import { K, SpendCapError } from "./controls.ts";

/**
 * Hard budgets (v2 Phase 3). Money is RESERVED before it can be spent, then SETTLED at the actual cost
 * or RELEASED. The ledger (`BudgetBook`) is synchronous over a key-value store: inside a Durable Object
 * (SQLite-backed, synchronous KV) each call runs to completion before the next, so 50 parallel
 * reservations can't jointly exceed a cap. Locally the same book runs behind an in-process lock.
 *
 * Scopes for one reservation: the task's own budget, the playbook's daily cap (from its spend tier),
 * the global daily cap, and for exploratory work the weekly explore share. All must have room.
 */
export interface SyncKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
}

export interface ScopeLimit {
  key: string;
  cap: number;
  /** Spend already on record when this scope is first seen (from the run log), so caps survive restarts. */
  seed_spent?: number;
}
interface ScopeState {
  cap: number;
  reserved: number;
  spent: number;
}
interface Reservation {
  amount: number;
  scopes: string[];
}

export type ReserveResult = { ok: true } | { ok: false; scope: string; cap: number; used: number };

const EPS = 1e-9;

export class BudgetBook {
  constructor(private readonly kv: SyncKv) {}

  private scope(s: ScopeLimit): ScopeState {
    const k = `scope:${s.key}`;
    const cur = this.kv.get<ScopeState>(k);
    if (cur) return { ...cur, cap: s.cap }; // caps can change (tier raised); usage carries over
    return { cap: s.cap, reserved: 0, spent: s.seed_spent ?? 0 };
  }

  /** All-or-nothing: either every scope has room and all are reserved, or nothing changes. */
  reserve(id: string, amount: number, scopes: ScopeLimit[]): ReserveResult {
    if (this.kv.get<Reservation>(`res:${id}`)) return { ok: true }; // idempotent
    const states = scopes.map((s) => ({ s, st: this.scope(s) }));
    for (const { s, st } of states)
      if (st.spent + st.reserved + amount > st.cap + EPS)
        return { ok: false, scope: s.key, cap: st.cap, used: st.spent + st.reserved };
    for (const { s, st } of states)
      this.kv.put(`scope:${s.key}`, { ...st, reserved: st.reserved + amount });
    this.kv.put(`res:${id}`, { amount, scopes: scopes.map((s) => s.key) } satisfies Reservation);
    return { ok: true };
  }

  /** The actual cost replaces the reservation. It's recorded even above the reservation (it happened). */
  settle(id: string, actual: number): { overrun: number } {
    const r = this.kv.get<Reservation>(`res:${id}`);
    if (!r) return { overrun: 0 };
    for (const key of r.scopes) {
      const st = this.kv.get<ScopeState>(`scope:${key}`);
      if (st)
        this.kv.put(`scope:${key}`, {
          ...st,
          reserved: Math.max(0, st.reserved - r.amount),
          spent: st.spent + actual,
        });
    }
    this.kv.delete(`res:${id}`);
    return { overrun: Math.max(0, actual - r.amount) };
  }

  release(id: string) {
    this.settle(id, 0);
  }

  usage(key: string) {
    return this.kv.get<ScopeState>(`scope:${key}`) ?? null;
  }
}

/** The async port the runner uses: a Durable Object on Cloudflare, a locked local book in Node. */
export interface BudgetPort {
  reserve(id: string, amount: number, scopes: ScopeLimit[]): Promise<ReserveResult>;
  settle(id: string, actual: number): Promise<{ overrun: number }>;
  release(id: string): Promise<void>;
}

export class MapKv implements SyncKv {
  private readonly m = new Map<string, unknown>();
  get<T>(k: string) {
    return this.m.get(k) as T | undefined;
  }
  put<T>(k: string, v: T) {
    this.m.set(k, structuredClone(v));
  }
  delete(k: string) {
    this.m.delete(k);
  }
}

/** Local port: one book per process; every call is serialised through a promise chain (a lock). */
export class LocalBudgetPort implements BudgetPort {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly book = new BudgetBook(new MapKv())) {}
  private locked<T>(fn: () => T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  reserve(id: string, amount: number, scopes: ScopeLimit[]) {
    return this.locked(() => this.book.reserve(id, amount, scopes));
  }
  settle(id: string, actual: number) {
    return this.locked(() => this.book.settle(id, actual));
  }
  release(id: string) {
    return this.locked(() => this.book.release(id));
  }
}

// ---- Spend tiers (S0–S3) and the explore share.

export type SpendTier = "S0" | "S1" | "S2" | "S3";
export const TIERS: SpendTier[] = ["S0", "S1", "S2", "S3"];

export async function spendTier(storage: Storage, playbook: string): Promise<SpendTier> {
  return (await storage.controls.get<SpendTier>(K.spendTier(playbook))) ?? "S0";
}

/** Daily cap for a playbook: S0 is the configured per-playbook cap; higher tiers come from config. */
export function playbookDailyCap(cfg: InfraConfig, playbook: string, tier: SpendTier): number {
  if (tier === "S0")
    return (
      cfg.caps.per_playbook_per_day_gbp[playbook] ?? cfg.caps.per_playbook_per_day_gbp.default ?? 0
    );
  return cfg.caps.spend_tiers[tier];
}

/**
 * Changes a playbook's spend tier. Going DOWN is always allowed (safer). Going UP needs a recorded,
 * unused owner approval for exactly this playbook and tier (v2 rule 14): agents can't raise budgets.
 */
export async function setSpendTier(
  storage: Storage,
  playbook: string,
  tier: SpendTier,
  o: { approvalId?: string; by: string },
) {
  const current = await spendTier(storage, playbook);
  if (TIERS.indexOf(tier) > TIERS.indexOf(current)) {
    const a = o.approvalId ? await storage.ownerApprovals.get(o.approvalId) : null;
    const value = a?.value as { tier?: string; type?: string; option?: string } | undefined;
    // v3: the approval is a recorded decision for exactly this playbook and tier (or a v2 tier approval).
    const okDecision =
      a?.kind === "decision" &&
      value?.type === "spend_tier" &&
      a.subject === `spend_tier:${playbook}:${tier}` &&
      value.option === "raise";
    const okV2 = a?.kind === "spend_tier" && a.subject === playbook && value?.tier === tier;
    if (!a || !(okDecision || okV2))
      throw new Error(
        `raising ${playbook} to ${tier} needs Archie's recorded approval for exactly that`,
      );
    if (!(await storage.ownerApprovals.use(a.id)))
      throw new Error("that approval was already used");
  }
  await storage.controls.set(K.spendTier(playbook), tier, o.by);
  await storage.alerts.raise(
    "spend_tier",
    `${playbook}: spend tier ${current} → ${tier} (${o.by})`,
    {
      approval: o.approvalId ?? null,
    },
  );
  return tier;
}

/** Exploratory work: experiment slots and explore-flagged leads. Capped at a weekly share of budget. */
export const isExplore = (task: Pick<StoredTask, "state">) => {
  const st = task.state as { experiment_id?: string; explore?: boolean };
  return Boolean(st.experiment_id || st.explore);
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** ISO week start (Monday, UTC). */
export function weekStart(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
}

/** The scopes a step's spend counts against, with seeds from what's already on record. */
export async function scopesFor(
  storage: Storage,
  cfg: InfraConfig,
  task: StoredTask,
  now: Date,
): Promise<ScopeLimit[]> {
  const day = `${dayKey(now)}T00:00:00.000Z`;
  const ex = cfg.caps.exclude_steps;
  const tier = await spendTier(storage, task.playbook);
  const scopes: ScopeLimit[] = [
    { key: `task:${task.task_id}`, cap: task.budget_gbp, seed_spent: task.cost_gbp },
    {
      key: `playbook:${task.playbook}:${dayKey(now)}`,
      cap: playbookDailyCap(cfg, task.playbook, tier),
      seed_spent: await storage.runLog.spendSince(day, task.playbook, ex),
    },
    {
      key: `global:${dayKey(now)}`,
      cap: cfg.caps.global_per_day_gbp,
      seed_spent: await storage.runLog.spendSince(day, undefined, ex),
    },
  ];
  if (isExplore(task)) {
    const wk = weekStart(now);
    scopes.push({
      key: `explore:${wk}`,
      cap: cfg.caps.explore_share * cfg.caps.global_per_day_gbp * 7,
      seed_spent: (await storage.budgetEvents.spendSince(`${wk}T00:00:00.000Z`)).explore,
    });
  }
  return scopes;
}

/**
 * Reserves before a step runs. Refusal behaves like a cap being hit: the queue pauses (unless it was
 * only the task's own budget), Archie is alerted, and SpendCapError stops the step.
 */
export async function reserveForStep(
  storage: Storage,
  cfg: InfraConfig,
  port: BudgetPort,
  task: StoredTask,
  amount: number,
  now: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  const explore = isExplore(task);
  const r = await port.reserve(id, amount, await scopesFor(storage, cfg, task, now));
  if (!r.ok) {
    await storage.budgetEvents.put({
      id,
      task_id: task.task_id,
      playbook: task.playbook,
      explore,
      reserved_gbp: amount,
      actual_gbp: null,
      status: "refused",
      reason: `${r.scope}: £${r.used.toFixed(2)} of £${r.cap.toFixed(2)} used`,
    });
    if (!r.scope.startsWith("task:")) await storage.controls.set(K.queuePaused, true, "budget");
    await storage.alerts.raise(
      "spend_cap",
      `Budget refused for ${task.playbook}: ${r.scope} has £${Math.max(0, r.cap - r.used).toFixed(2)} left of £${r.cap.toFixed(2)}`,
      { task_id: task.task_id, scope: r.scope },
    );
    throw new SpendCapError(`budget ${r.scope} full`);
  }
  await storage.budgetEvents.put({
    id,
    task_id: task.task_id,
    playbook: task.playbook,
    explore,
    reserved_gbp: amount,
    actual_gbp: null,
    status: "reserved",
    reason: null,
  });
  return id;
}

export async function settleStep(
  storage: Storage,
  port: BudgetPort,
  id: string,
  task: StoredTask,
  reserved: number,
  actual: number,
) {
  const r = await port.settle(id, actual);
  await storage.budgetEvents.put({
    id,
    task_id: task.task_id,
    playbook: task.playbook,
    explore: isExplore(task),
    reserved_gbp: reserved,
    actual_gbp: actual,
    status: "settled",
    reason:
      r.overrun > 0
        ? `cost £${actual.toFixed(4)} was above the £${reserved.toFixed(4)} reserved`
        : null,
  });
  if (r.overrun > 0)
    await storage.alerts.raise(
      "budget_overrun",
      `${task.playbook}: a step cost more than reserved`,
      {
        task_id: task.task_id,
        reserved,
        actual,
      },
    );
}

export async function releaseStep(
  storage: Storage,
  port: BudgetPort,
  id: string,
  task: StoredTask,
  reserved: number,
) {
  await port.release(id);
  await storage.budgetEvents.put({
    id,
    task_id: task.task_id,
    playbook: task.playbook,
    explore: isExplore(task),
    reserved_gbp: reserved,
    actual_gbp: 0,
    status: "released",
    reason: null,
  });
}
