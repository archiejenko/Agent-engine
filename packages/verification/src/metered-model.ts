import type { ModelsConfig } from "@ae/config";
import { type CostMeter, costGbp, type ModelClient, type ModelRequest } from "@ae/ports";
import type { Storage } from "@ae/storage";

/**
 * The single point every agent-side model call passes through (data layer plan, commit 0). Each call
 * writes exactly one `cost_events` row the moment it returns, before the caller sees the answer, so the
 * cost tracker and spend caps never lag behind the money.
 *
 * - The amount uses the same formula the runner has always used (`costGbp` with the configured price,
 *   the fake model priced at its own entry), so cap totals don't change.
 * - A real model call costs money even while external actions run dry, so it's never `dry_run`.
 * - The fake model's calls are marked synthetic (no real money).
 * - Callers only label a call (`req.meter`); they never write cost rows themselves.
 */
const METERED = Symbol.for("ae.metered-model");

export type CostMode = NonNullable<CostMeter["mode"]>;

export interface MeterDeps {
  storage: Storage;
  models: ModelsConfig;
  /** The mode a call gets when its label doesn't say (the service's: "sandbox" in a sandbox). */
  mode?: CostMode;
  now?: () => Date;
}

export function priceOfCall(
  models: ModelsConfig,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
) {
  const price = models.prices[model] ?? models.prices["fake-model"];
  return price ? costGbp(usage, price, models.usd_to_gbp) : 0;
}

export function isMetered(model: ModelClient): boolean {
  return (model as unknown as Record<symbol, boolean>)[METERED] === true;
}

/** Wraps a model so every call writes its cost event. Wrapping twice is a no-op. */
export function meteredModel(inner: ModelClient, d: MeterDeps): ModelClient {
  if (isMetered(inner)) return inner;
  const wrapped: ModelClient = {
    name: inner.name,
    complete: async (req: ModelRequest) => {
      const res = await inner.complete(req);
      const m = req.meter ?? {};
      const amount = priceOfCall(d.models, res.model, res.usage);
      await d.storage.costEvents.add({
        event_id: crypto.randomUUID(),
        at: (d.now?.() ?? new Date()).toISOString(),
        run_id: m.run_id ?? null,
        graph_id: m.graph_id ?? null,
        graph_version: m.graph_version ?? null,
        node_id: m.node_id ?? null,
        task_id: m.task_id ?? null,
        opportunity_id: m.opportunity_id ?? null,
        revenue_path: m.revenue_path ?? null,
        shape_fingerprint: m.shape ?? null,
        mode: m.mode ?? d.mode ?? "live",
        category: "model",
        unit: "model_call",
        quantity: 1,
        unit_price_gbp: amount,
        amount_gbp: amount,
        price_table_version: d.models.price_table_version,
        synthetic: res.model === "fake-model" || m.synthetic === true,
        dry_run: false,
        playbook: m.playbook ?? null,
        step_id: m.step_id ?? null,
      });
      return res;
    },
  };
  Object.defineProperty(wrapped, METERED, { value: true });
  return wrapped;
}

/** The same model, with `meter` filled in on every request (a caller's labels win over these). */
export function withMeter(model: ModelClient, meter: CostMeter): ModelClient {
  const labelled: ModelClient = {
    name: model.name,
    complete: (req: ModelRequest) =>
      model.complete({ ...req, meter: { ...meter, ...(req.meter ?? {}) } }),
  };
  if (isMetered(model)) Object.defineProperty(labelled, METERED, { value: true });
  return labelled;
}

/** Cost labels for a task step. */
export function taskMeter(
  task: {
    task_id: string;
    playbook: string;
    revenue_path: string;
    source_ref: string;
    synthetic?: boolean;
  },
  step_id: string | null,
  extra: CostMeter = {},
): CostMeter {
  return {
    task_id: task.task_id,
    playbook: task.playbook,
    step_id,
    revenue_path: task.revenue_path,
    opportunity_id: task.source_ref.match(/^opportunity:([^:]+)/)?.[1] ?? null,
    synthetic: task.synthetic === true,
    ...extra,
  };
}

/**
 * The website extractor's fallback (2026-11-27): try `primary` (Gemini 4 Hydrogen); if a call errors,
 * or returns text that isn't a JSON object when a JSON schema was asked for, try once more; then use
 * `fallback` (Claude) for that request. Both clients must already be metered, so EVERY attempt that
 * returned a response writes its own cost event: a failed Hydrogen attempt still cost money. A request
 * that errored before any response cost nothing and writes nothing.
 */
export function withFallback(
  primary: ModelClient,
  fallback: ModelClient,
  o: { retries?: number; onFallback?: (reason: string) => void } = {},
): ModelClient {
  if (!isMetered(primary) || !isMetered(fallback))
    throw new Error("withFallback: both models must be metered, so every attempt is on the ledger");
  const tries = 1 + (o.retries ?? 1);
  const wrapped: ModelClient = {
    name: `${primary.name}→${fallback.name}`,
    complete: async (req: ModelRequest) => {
      let reason = "";
      for (let i = 0; i < tries; i++) {
        try {
          const r = await primary.complete(req);
          if (!req.json_schema || isJsonObject(r.text)) return r;
          reason = "invalid JSON";
        } catch (e) {
          reason = (e as Error).message.slice(0, 200);
        }
      }
      o.onFallback?.(reason);
      return fallback.complete(req);
    },
  };
  Object.defineProperty(wrapped, METERED, { value: true });
  return wrapped;
}

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}
