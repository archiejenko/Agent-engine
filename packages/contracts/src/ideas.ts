import { z } from "zod";

/**
 * v3 Phase 6 (with v2 Phase 7): signals, idea cards, the thread, and the Board.
 *
 * - A **signal** is the only thing a scout outputs. It is short, typed data: no free text can ride in it
 *   (its value is a number, a boolean, or a short plain string), and it is always marked untrusted.
 * - An **idea card** is versioned: a revision is a new version, never an edit. Every number on it is a
 *   `Figure` labelled real, estimated or assumed; anything not real states its assumption.
 * - All maths on a card is done in code (rule 4), never by a model.
 */

export const FigureLabel = z.enum(["real", "estimated", "assumed"]);
export type FigureLabel = z.infer<typeof FigureLabel>;

export const Figure = z
  .object({
    value: z.number().finite(),
    label: FigureLabel,
    /** Required unless the figure is real: what it rests on. */
    assumption: z.string().min(1).max(300).nullable(),
  })
  .strict()
  .refine((f) => f.label === "real" || f.assumption !== null, {
    message: "an estimated or assumed figure must state its assumption",
  });
export type Figure = z.infer<typeof Figure>;

/** Plain short strings only: no newlines, no markup, nothing that reads as an instruction block. */
const PlainShort = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9 £%&'.,:()/+-]+$/, "plain short text only");

export const Signal = z
  .object({
    signal_id: z.string().regex(/^sig-[a-z0-9-]{4,60}$/),
    /** The scouting field (config `ideas.fields[].id`). */
    field: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    source_name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    source_url: z.string().url().max(500),
    lane: z.enum(["open", "licensed"]),
    entity_id: z.string().max(20).nullable(),
    signal_type: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    /** A number, a boolean, or a short lowercase token (a status or code): never a sentence. */
    value: z.union([
      z.number().finite(),
      z.boolean(),
      z
        .string()
        .regex(/^[a-z0-9][a-z0-9_.-]{0,59}$/, "a value is a number, a boolean or a short code"),
    ]),
    taxonomy_node: z.string().regex(/^[a-z][a-z0-9_]{1,60}$/),
    market: z.object({ buyer: PlainShort, industry: PlainShort.nullable() }).strict(),
    observed_at: z.string().datetime(),
    /** Always true: a signal comes from outside and is data, never instructions. */
    untrusted: z.literal(true),
  })
  .strict();
export type Signal = z.infer<typeof Signal>;

export const MonetisationRoute = z.enum(["sell_fix", "sell_intro", "sell_data"]);

/** Checked automatically every day against the experiment's own ledger rows. */
export const KillMetric = z.enum([
  "demo_visits_per_100_sends",
  "replies_per_100_sends",
  "paid_per_100_sends",
  "spend_gbp",
]);
export const KillCriterion = z
  .object({
    metric: KillMetric,
    op: z.enum(["<", ">="]),
    threshold: z.number().finite(),
    /** Checked from this day of the experiment on. */
    by_day: z.number().int().min(1).max(365),
  })
  .strict();
export type KillCriterion = z.infer<typeof KillCriterion>;

export const IdeaCard = z
  .object({
    card_id: z.string().regex(/^card-[a-z0-9-]{4,60}$/),
    version: z.number().int().positive(),
    parent_version: z.number().int().positive().nullable(),
    hypothesis_id: z.string().nullable(),
    field: z.string(),
    market: z.object({
      key: z.string().min(1),
      buyer: z.string(),
      industry: z.string().nullable(),
    }),
    offer: z.string().min(1).max(300),
    thesis: z.string().min(1).max(800),
    taxonomy_node: z.string().min(1),
    route: MonetisationRoute,
    lane: z.enum(["open", "licensed"]),
    regulated: z.boolean(),
    /** Filled in by Archie on a regulated introduction card before it can be passed. */
    legal_check: z.object({ by: z.string(), note: z.string().min(1), at: z.string() }).nullable(),
    evidence: z
      .object({
        fact_ids: z.array(z.string()),
        signal_ids: z.array(z.string()),
        vault_notes: z.array(z.string()),
      })
      .refine((e) => e.fact_ids.length + e.signal_ids.length > 0, {
        message: "a card needs at least one verified fact or signal as evidence",
      }),
    economics: z.object({
      cost_to_serve: z.object({
        total: Figure,
        model: Figure,
        hosting: Figure,
        third_party: Figure,
        owner_minutes: Figure,
        owner_cost: Figure,
      }),
      cost_to_acquire: z.object({
        total: Figure,
        sends_needed: Figure,
        cost_per_send: Figure,
        p_paid: Figure,
      }),
      first_year_value: Figure,
      payback_months: Figure,
      market_size_companies: Figure,
      expected_profit: Figure,
      owner_hours: Figure,
      profit_per_owner_hour: Figure,
    }),
    test: z.object({
      budget_gbp: Figure,
      sample_size: z.number().int().positive(),
      time_cap_days: z.number().int().positive(),
      weekly_volume: Figure,
      /** Whether the weekly volume reaches the sample size inside the time cap (the volume check). */
      reachable: z.boolean(),
      days_to_first_gbp: Figure,
    }),
    kill_criteria: z.array(KillCriterion).min(1),
    success_criteria: z.string().min(1).max(300),
    next_budget_step_gbp: z.number().nonnegative(),
    playbooks: z.array(z.string()).min(1),
    /** Required when the card re-raises a hypothesis Archie failed: what is different this time. */
    what_changed: z.string().min(1).max(500).nullable(),
    /** Assumptions the planner revised in answer to Archie (each revision is a new version). */
    overrides: z
      .object({
        first_year_value_gbp: z.number().positive().optional(),
        budget_gbp: z.number().positive().optional(),
        sample_size: z.number().int().positive().optional(),
        time_cap_days: z.number().int().positive().optional(),
        why: z.string().min(1).max(200),
      })
      .strict()
      .nullable()
      .default(null),
    created_by: z.string().min(1),
    created_at: z.string(),
  })
  .strict();
export type IdeaCard = z.infer<typeof IdeaCard>;

export const CardStatus = z.enum([
  "proposed",
  "rejected_underpowered",
  "blocked_reraise",
  "parked",
  "passed",
  "budget_pending",
  "failed",
  "testing",
  "killed",
  "succeeded",
  "superseded",
]);
export type CardStatus = z.infer<typeof CardStatus>;

export const BoardColumn = z.enum([
  "scanning",
  "researching",
  "proposed",
  "testing",
  "live",
  "killed",
]);
export type BoardColumn = z.infer<typeof BoardColumn>;

export const ThreadKind = z.enum(["question", "answer", "comment", "revision"]);
