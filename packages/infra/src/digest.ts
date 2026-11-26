import type { DecisionsConfig, InfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";

/**
 * The daily digest (v3 Phase 2): what happened yesterday, what was earned and spent, what's waiting.
 * Shown on the dashboard; emailed through the mailbox port once a real sender exists. All maths here.
 */
export interface Digest {
  day: string;
  happened: Record<string, number>;
  earned_gbp: number;
  spent_gbp: number;
  waiting: {
    open: number;
    top: { id: string; summary: string; money_at_stake_gbp: number; deadline: string }[];
  };
  defaulted: { id: string; summary: string; chose: string | null }[];
  decided: number;
  label: "real" | "includes simulated rows";
}

export async function buildDigest(
  storage: Storage,
  cfg: InfraConfig,
  o: { day: string; includeSynthetic?: boolean },
): Promise<Digest> {
  const from = `${o.day}T00:00:00.000Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const rows = await storage.ledgerRange({
    from,
    to,
    includeSynthetic: o.includeSynthetic ?? false,
  });
  const happened: Record<string, number> = {};
  for (const r of rows) happened[r.event] = (happened[r.event] ?? 0) + 1;
  const money = (e: string) =>
    rows
      .filter((r) => r.event === e && r.value_kind === "actual")
      .reduce((a, r) => a + (r.value_gbp ?? 0), 0);
  const spent =
    (await storage.costEvents.spendSince(from)) - (await storage.costEvents.spendSince(to));
  const open = await storage.decisions.list({ status: "open", limit: 1000 });
  const closed = (await storage.decisions.since(from)).filter((x) => (x.decided_at ?? "") < to);
  void cfg;
  return {
    day: o.day,
    happened,
    earned_gbp: Math.round((money("paid") - money("refunded")) * 100) / 100,
    spent_gbp: Math.round(spent * 100) / 100,
    waiting: {
      open: open.length,
      top: open.slice(0, 5).map((x) => ({
        id: x.id,
        summary: x.summary,
        money_at_stake_gbp: x.money_at_stake_gbp,
        deadline: x.deadline,
      })),
    },
    defaulted: closed
      .filter((x) => x.status === "defaulted")
      .map((x) => ({ id: x.id, summary: x.summary, chose: x.chosen_option })),
    decided: closed.filter((x) => x.status === "decided").length,
    label: rows.some((r) => r.synthetic) ? "includes simulated rows" : "real",
  };
}

/** Builds yesterday's digest once, after the configured hour (the cron calls this every run). */
export async function dailyDigest(
  storage: Storage,
  cfg: InfraConfig,
  dcfg: DecisionsConfig,
  now: Date = new Date(),
): Promise<Digest | null> {
  if (now.getUTCHours() < dcfg.digest_hour_utc) return null;
  const day = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (await storage.digests.get(day)) return null;
  const d = await buildDigest(storage, cfg, { day });
  await storage.digests.put(day, d);
  return d;
}
