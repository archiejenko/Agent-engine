import type { ModelsConfig } from "@ae/config";

/**
 * Pricing in code (CLAUDE.md: all maths in code). A model call is priced from the token usage the
 * Claude API reports on every response, times the versioned price table in config. Tokens are never
 * estimated when the API reports them. Each priced line becomes one cost event.
 */
export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** "5m" (default) or "1h" cache writes. */
  cache_ttl?: "5m" | "1h";
}

export interface PricedLine {
  unit: "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens";
  quantity: number;
  unit_price_gbp: number;
  amount_gbp: number;
}

export class UnknownModelPriceError extends Error {}

export function priceModelCall(
  model: string,
  usage: ModelUsage,
  cfg: Pick<ModelsConfig, "prices" | "usd_to_gbp">,
): { lines: PricedLine[]; total_gbp: number } {
  const p = cfg.prices[model];
  if (!p) throw new UnknownModelPriceError(`no price for ${model}`);
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  // Long-context tier: counts ALL input tokens, cache reads and writes included.
  const allInput = usage.input_tokens + read + write;
  const tier =
    p.long_context && allInput > p.long_context.over_input_tokens ? p.long_context : null;
  const inUsd = tier?.input_usd_per_mtok ?? p.input_usd_per_mtok;
  const outUsd = tier?.output_usd_per_mtok ?? p.output_usd_per_mtok;
  const readUsd = tier?.cache_read_usd_per_mtok ?? p.cache_read_usd_per_mtok ?? inUsd * 0.1;
  const writeUsd =
    usage.cache_ttl === "1h"
      ? (p.cache_write_1h_usd_per_mtok ?? inUsd * 2)
      : (p.cache_write_5m_usd_per_mtok ?? inUsd * 1.25);
  const gbpPerToken = (usdPerMtok: number) => (usdPerMtok * cfg.usd_to_gbp) / 1_000_000;
  const lines: PricedLine[] = [];
  const add = (unit: PricedLine["unit"], quantity: number, usdPerMtok: number) => {
    if (quantity <= 0) return;
    const unit_price_gbp = gbpPerToken(usdPerMtok);
    lines.push({ unit, quantity, unit_price_gbp, amount_gbp: quantity * unit_price_gbp });
  };
  add("input_tokens", usage.input_tokens, inUsd);
  add("output_tokens", usage.output_tokens, outUsd);
  add("cache_read_tokens", read, readUsd);
  add("cache_write_tokens", write, writeUsd);
  return { lines, total_gbp: lines.reduce((a, l) => a + l.amount_gbp, 0) };
}

/** Roll-up: sum of event amounts, grouped by a key. Roll-ups are always sums of events, never stored. */
export function rollUp<T extends { amount_gbp: number }>(events: T[], key: (e: T) => string) {
  const out = new Map<string, { gbp: number; n: number }>();
  for (const e of events) {
    const k = key(e);
    const cur = out.get(k) ?? { gbp: 0, n: 0 };
    cur.gbp += e.amount_gbp;
    cur.n += 1;
    out.set(k, cur);
  }
  return out;
}
