import { z } from "zod";

/**
 * v2 outcome ledger. One row per funnel event, linked to the task (and playbook version, cohort arm,
 * experiment, hypothesis) that earned it. Learning reads only rows with synthetic = false and
 * dry_run = false that were recorded before the learning time (point-in-time).
 */
export const FUNNEL_EVENTS = [
  "sent",
  "delivered",
  "qr_scan",
  "demo_visit",
  "reply",
  "reply_positive",
  "booking",
  "checkout_started",
  "paid",
  "refunded",
  "churned",
] as const;
export const FunnelEvent = z.enum(FUNNEL_EVENTS);
export type FunnelEvent = z.infer<typeof FunnelEvent>;

export const LedgerSource = z.enum([
  "human",
  "system",
  "verified_fact",
  "stripe",
  "demo",
  "inbox",
  "outbox",
  "letters",
  "simulator",
]);
export type LedgerSource = z.infer<typeof LedgerSource>;

export const Arm = z.enum(["ranked", "holdout"]);
export type Arm = z.infer<typeof Arm>;

export const LedgerEvent = z
  .object({
    event: FunnelEvent,
    entity_id: z.string().min(1),
    task_id: z.string().nullable().default(null),
    playbook: z.string().nullable().default(null),
    playbook_version: z.number().int().nullable().default(null),
    opportunity_id: z.string().nullable().default(null),
    experiment_id: z.string().nullable().default(null),
    hypothesis_id: z.string().nullable().default(null),
    cohort_id: z.string().nullable().default(null),
    arm: Arm.nullable().default(null),
    /** £ value: actual (money moved) or an estimate whose assumption is stored alongside. */
    value_gbp: z.number().nullable().default(null),
    value_kind: z.enum(["actual", "estimate"]).default("actual"),
    assumption: z.string().nullable().default(null),
    ms_on_page: z.number().int().nonnegative().nullable().default(null),
    observed_at: z.iso.datetime(),
    source: LedgerSource,
    synthetic: z.boolean().default(false),
    /** A simulated (kill switch on) send: never counts as a real contact for learning. */
    dry_run: z.boolean().default(false),
    /** Makes recording idempotent: the same key is stored once. */
    dedupe_key: z.string().min(1),
  })
  .refine((e) => e.value_kind !== "estimate" || (e.assumption ?? "").length > 0, {
    message: "an estimated £ value must state its assumption",
    path: ["assumption"],
  });
export type LedgerEvent = z.input<typeof LedgerEvent>;
export type LedgerEventParsed = z.output<typeof LedgerEvent>;
