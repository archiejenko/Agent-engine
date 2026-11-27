import type { InfraConfig } from "@ae/config";
import type { LedgerRow, Storage } from "@ae/storage";
import { unitEconomics } from "./economics.ts";
import { liftReport } from "./lift.ts";

/**
 * Home (v3 Phase 1): the business on one screen, computed from the outcome ledger (and claims for
 * recurring revenue). Every figure says what kind of number it is:
 *   real       — from actual events (payments, sends that happened);
 *   estimated  — built from estimates or the current conversion model;
 *   assumed    — rests on a placeholder Archie hasn't set (e.g. the hourly rate);
 *   dry_run    — the events behind it were simulated sends (kill switch on);
 *   synthetic  — simulator rows are included (never real).
 * All maths here, never in a model.
 */
export type FigureKind = "real" | "estimated" | "assumed" | "dry_run" | "synthetic";

export interface Figure {
  key: string;
  label: string;
  value: number | null;
  unit: "gbp" | "count" | "ratio" | "minutes" | "lift";
  kind: FigureKind;
  note: string | null;
  ci95?: [number, number] | null;
}

const OUTREACH = ["sme_outreach", "sme_letter", "post_reply"];
const ACTIVE_CLAIM = ["paid", "details_received", "awaiting_publish", "published"];

/** The weakest label wins: synthetic > dry_run > assumed > estimated > real. */
export function weakest(...kinds: FigureKind[]): FigureKind {
  const order: FigureKind[] = ["real", "estimated", "assumed", "dry_run", "synthetic"];
  return kinds.reduce(
    (a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a),
    "real" as FigureKind,
  );
}

const kindOfRows = (rows: LedgerRow[]): FigureKind =>
  rows.some((r) => r.synthetic) ? "synthetic" : rows.some((r) => r.dry_run) ? "dry_run" : "real";

export async function homeFigures(
  storage: Storage,
  cfg: InfraConfig,
  o: { from: string; to: string; playbook?: string; includeSynthetic: boolean },
): Promise<{ from: string; to: string; playbook: string | null; figures: Figure[] }> {
  const rows = await storage.ledgerRange(o);
  const ev = (e: string) => rows.filter((r) => r.event === e);
  const money = (rs: LedgerRow[]) =>
    rs.filter((r) => r.value_kind === "actual").reduce((a, r) => a + (r.value_gbp ?? 0), 0);
  const paid = ev("paid");
  const refunded = ev("refunded");
  const revenue = money(paid) - money(refunded);
  const sent = ev("sent");
  const sentCos = new Set(sent.map((r) => r.entity_id));
  const replied = new Set(ev("reply").map((r) => r.entity_id));
  const buyers = new Set(paid.map((r) => r.entity_id));
  // Pipeline: companies showing interest that haven't paid or left; their latest estimated value.
  const closed = new Set([...buyers, ...ev("churned").map((r) => r.entity_id)]);
  const pipe = new Map<string, number>();
  for (const r of rows)
    if (r.value_kind === "estimate" && !closed.has(r.entity_id) && r.event !== "sent")
      pipe.set(r.entity_id, r.value_gbp ?? 0);
  const pipeline = [...pipe.values()].reduce((a, b) => a + b, 0);

  // Recurring revenue: active claimed sites (monthly price), playbook filter doesn't apply.
  const claims = (
    await storage.siteClaims.list({ includeSynthetic: o.includeSynthetic, limit: 10_000 })
  ).filter((c) => ACTIVE_CLAIM.includes(c.status));
  const mrr = claims.reduce((a, c) => a + c.monthly_gbp, 0);

  // Costs and minutes (tasks created in the range), with Archie's minutes at the hourly rate.
  const econ = await unitEconomics(storage, cfg, {
    since: o.from,
    until: o.to,
    includeSynthetic: o.includeSynthetic,
  });
  const rate = cfg.owner.hourly_gbp;
  const rateKind: FigureKind = cfg.owner.hourly_is_assumption ? "assumed" : "real";
  const pick = (keys: string[]) =>
    econ.by_playbook
      .filter((p) => keys.includes(p.key) && (!o.playbook || p.key === o.playbook))
      .reduce(
        (a, p) => ({
          spend: a.spend + p.model_cost_gbp + p.send_cost_gbp,
          minutes: a.minutes + p.human_minutes,
        }),
        { spend: 0, minutes: 0 },
      );
  const outreach = pick(OUTREACH);
  const serve = pick(["claim_site"]);
  const all = pick(econ.by_playbook.map((p) => p.key));
  const sessions = await storage.reviewSessions.since({
    since: o.from,
    includeSynthetic: o.includeSynthetic,
  });
  const minutes =
    sessions.filter((s) => s.decided_at < o.to).reduce((a, s) => a + s.active_ms, 0) / 60_000;
  const lift = await liftReport(storage, { includeSynthetic: o.includeSynthetic });
  const liftRow =
    lift.events.find((e) => e.event === "paid" && e.lift !== null) ??
    lift.events.find((e) => e.event === "reply" && e.lift !== null);
  const base = kindOfRows(rows);
  const synth =
    o.includeSynthetic && (rows.some((r) => r.synthetic) || claims.some((c) => c.synthetic));

  const figures: Figure[] = [
    {
      key: "revenue",
      label: "Revenue",
      value: round2(revenue),
      unit: "gbp",
      kind: base,
      note: "payments minus refunds",
    },
    {
      key: "mrr",
      label: "Monthly recurring revenue",
      value: round2(mrr),
      unit: "gbp",
      kind: synth ? "synthetic" : "real",
      note: `${claims.length} active site subscription(s)`,
    },
    {
      key: "pipeline",
      label: "Pipeline value",
      value: round2(pipeline),
      unit: "gbp",
      kind: weakest(base, "estimated"),
      note: `${pipe.size} interested companies × estimated value (P(paid) model)`,
    },
    {
      key: "sends",
      label: "Sends",
      value: sent.length,
      unit: "count",
      kind: base,
      note: "emails and letters",
    },
    {
      key: "reply_rate",
      label: "Reply rate",
      value: sentCos.size
        ? round4([...replied].filter((x) => sentCos.has(x)).length / sentCos.size)
        : null,
      unit: "ratio",
      kind: base,
      note: `${replied.size} of ${sentCos.size} companies contacted`,
    },
    {
      key: "sales",
      label: "Sales",
      value: buyers.size,
      unit: "count",
      kind: base,
      note: "companies that paid",
    },
    {
      key: "cac",
      label: "Cost to acquire a customer",
      value: buyers.size
        ? round2((outreach.spend + (outreach.minutes / 60) * rate) / buyers.size)
        : null,
      unit: "gbp",
      kind: weakest(base, "estimated", rateKind),
      note: `outreach model + sending costs + your minutes at £${rate}/h, per sale`,
    },
    {
      key: "cost_to_serve",
      label: "Cost to serve",
      value: claims.length
        ? round2((serve.spend + (serve.minutes / 60) * rate) / claims.length)
        : null,
      unit: "gbp",
      kind: weakest(base, "estimated", rateKind),
      note: "fulfilment costs + your minutes, per active customer",
    },
    {
      key: "margin",
      label: "Margin",
      value: round2(revenue - all.spend - (minutes / 60) * rate),
      unit: "gbp",
      kind: weakest(base, rateKind),
      note: `revenue − all model and sending costs − your minutes at £${rate}/h`,
    },
    {
      key: "lift",
      label: liftRow ? `Ranked vs holdout (${liftRow.event})` : "Ranked vs holdout",
      value: liftRow?.lift ?? null,
      unit: "lift",
      ci95: liftRow?.ci95 ?? null,
      kind: o.includeSynthetic ? "synthetic" : "real",
      note: lift.note,
    },
    {
      key: "review_minutes",
      label: "Your review minutes",
      value: round2(minutes),
      unit: "minutes",
      kind: synth ? "synthetic" : "real",
      note: null,
    },
  ];
  return { from: o.from, to: o.to, playbook: o.playbook ?? null, figures };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
