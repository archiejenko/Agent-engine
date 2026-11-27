import type { Storage } from "@ae/storage";

/**
 * Runway (Archie, 26 Nov 2026): pool balance ÷ average live daily spend over the last 7 complete days.
 * Pool balance = every pool event (top-ups and adjustments) − live spend since the first pool event.
 * Live = mode 'live', synthetic 0, dry_run 0, whatever any view's simulated switch says: this is money
 * that controls spending. All maths here (rule 4); the cockpit panel and the low-runway rule share it.
 */
export interface Runway {
  /** false until a top-up is recorded: then every figure is null (shown as "–", never a guess). */
  recorded: boolean;
  balance: number | null;
  avg7: number | null;
  /** null when there was no live spend in the last 7 days (the pool isn't running down). */
  days: number | null;
  top_up_by: string | null;
  /** The newest pool event: a low-runway episode belongs to the top-up before it. */
  last_event_id: string | null;
}

const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const round2 = (x: number) => Math.round(x * 100) / 100;

export async function runwayFigures(storage: Storage, now: Date): Promise<Runway> {
  const events = await storage.poolEvents.list();
  const today = dayOf(now.toISOString());
  if (!events.some((e) => e.kind === "topup"))
    return {
      recorded: false,
      balance: null,
      avg7: null,
      days: null,
      top_up_by: null,
      last_event_id: null,
    };
  const first = dayOf(events[0]?.at ?? today);
  const live = (await storage.dailyRollups.range({ from: first, to: addDays(today, 1) })).filter(
    (r) => r.mode === "live" && !r.dry_run && !r.synthetic,
  );
  const spent = live.reduce((a, r) => a + r.cost_gbp, 0);
  const balance = events.reduce((a, e) => a + e.amount_gbp, 0) - spent;
  const weekStart = addDays(today, -7);
  const avg7 =
    live.filter((r) => r.day >= weekStart && r.day < today).reduce((a, r) => a + r.cost_gbp, 0) / 7;
  const days = avg7 > 0 ? Math.max(0, balance) / avg7 : null;
  return {
    recorded: true,
    balance: round2(balance),
    avg7: round2(avg7),
    days: days === null ? null : Math.round(days * 10) / 10,
    top_up_by: days === null ? null : addDays(today, Math.floor(days)),
    last_event_id: events.at(-1)?.event_id ?? null,
  };
}
