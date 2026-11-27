import {
  ConfidenceConfig,
  type FieldDefinition,
  FieldRegistry,
  UniverseConfig,
} from "@ae/contracts";
import { z } from "zod";
import chJson from "./companies_house.json" with { type: "json" };
import confidenceJson from "./confidence.json" with { type: "json" };
import decisionsJson from "./decisions.json" with { type: "json" };
import registryJson from "./field-registry.json" with { type: "json" };
import graphPolicyJson from "./graph-policy.json" with { type: "json" };
import ideaCategoriesJson from "./idea-categories.json" with { type: "json" };
import ideaFunctionsJson from "./idea-functions.json" with { type: "json" };
import ideasJson from "./ideas.json" with { type: "json" };
import infraJson from "./infra.json" with { type: "json" };
import infraPricesJson from "./infra-prices.json" with { type: "json" };
import keysJson from "./keys.json" with { type: "json" };
import modelsJson from "./models.json" with { type: "json" };
import productsJson from "./products.json" with { type: "json" };
import sicSectorsJson from "./sic-sectors.json" with { type: "json" };
import triggersJson from "./triggers.json" with { type: "json" };
import universeJson from "./universe.lead_gen.json" with { type: "json" };
import verificationJson from "./verification.json" with { type: "json" };

/**
 * Config is data, not code. Each file is validated on load; an invalid file stops the program
 * rather than running with a guessed value.
 */
export function loadUniverseConfig(raw: unknown = universeJson): UniverseConfig {
  return UniverseConfig.parse(raw);
}

export function loadConfidenceConfig(raw: unknown = confidenceJson): ConfidenceConfig {
  return ConfidenceConfig.parse(raw);
}

/** True if a company with these SIC codes is excluded from the universe. */
export function isSicExcluded(sicCodes: readonly string[], universe: UniverseConfig): boolean {
  const excluded = new Set(universe.sic_exclude.map((s) => s.code));
  // A company is excluded only if ALL its SIC codes are excluded ones; a trading company that
  // also lists a holding-company code is kept.
  return sicCodes.length > 0 && sicCodes.every((c) => excluded.has(c));
}

export function loadConfidenceConfigChecked(raw?: unknown): ConfidenceConfig {
  const c = loadConfidenceConfig(raw);
  for (const [name, src] of Object.entries(c.sources)) {
    if (src.lane === "licensed")
      throw new Error(`source ${name} is licensed; no licensed data in this build`);
  }
  return c;
}

/** The field registry as a map. Unknown fields are not in it and must be dropped, never guessed. */
export function loadFieldRegistry(raw: unknown = registryJson): Map<string, FieldDefinition> {
  const defs = FieldRegistry.parse(raw);
  return new Map(defs.map((d) => [d.field, d]));
}

/** Short fingerprint of a config object, recorded on every run (reproducibility). */
export async function configVersion(obj: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const VerificationConfig = z.object({
  triangulation: z.object({ clear_margin: z.number().min(0).max(1) }),
  sanity: z.object({
    max_employees: z.number().int().positive(),
    revenue_per_employee_gbp: z.object({ min: z.number().positive(), max: z.number().positive() }),
  }),
  resolution: z.object({
    weights: z.object({
      name: z.number().min(0),
      postcode: z.number().min(0),
      domain: z.number().min(0),
    }),
    auto_match: z.number().min(0).max(1),
    adjudicate: z.number().min(0).max(1),
  }),
  drift: z.object({
    baseline_days: z.number().int().positive(),
    min_baseline_days: z.number().int().positive(),
    /** A source isn't judged until this many complete (not partial, not failed) runs have fed it. */
    min_complete_runs: z.number().int().positive(),
    volume_ratio_min: z.number().positive(),
    volume_ratio_max: z.number().positive(),
    null_rate_increase_max: z.number().positive(),
    match_rate_drop_max: z.number().positive(),
    mean_relative_change_max: z.number().positive(),
  }),
  golden: z.object({
    target_companies: z.number().int().positive(),
    fields: z.array(z.string()).min(1),
  }),
  reverify: z.object({
    daily_call_budget: z.number().int().positive(),
    calls_per_company: z.number().positive(),
    request_weight: z.number().positive(),
    opportunity_weight: z.number().positive(),
  }),
});
export type VerificationConfig = z.infer<typeof VerificationConfig>;

export function loadVerificationConfig(raw: unknown = verificationJson): VerificationConfig {
  const c = VerificationConfig.parse(raw);
  if (c.resolution.adjudicate > c.resolution.auto_match) {
    throw new Error("resolution.adjudicate must be <= resolution.auto_match");
  }
  return c;
}

export const CompaniesHouseConfig = z.object({
  api_base_url: z.url(),
  rate_limit: z.object({
    requests: z.number().int().positive(),
    window_seconds: z.number().int().positive(),
    /** Share of the documented limit we actually use, leaving headroom. */
    use_share: z.number().gt(0).max(1),
  }),
  items_per_page: z.number().int().min(1).max(100),
  max_pages: z.number().int().positive(),
  max_retries: z.number().int().min(0),
  /** How many years of officer/filing/charge/PSC history to keep in snapshots. */
  history_years: z.number().int().positive(),
  /** Filing history is the bulkiest field, so it keeps a shorter window. */
  filing_history_years: z.number().int().positive(),
  fetch_charges_only_if_flagged: z.boolean(),
});
export type CompaniesHouseConfig = z.infer<typeof CompaniesHouseConfig>;

export function loadCompaniesHouseConfig(raw: unknown = chJson): CompaniesHouseConfig {
  return CompaniesHouseConfig.parse(raw);
}

const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const RoleName = z.enum([
  "extractor",
  "researcher",
  "writer",
  "checker",
  "explainer",
  "adjudicator",
  "verifier",
  "planner",
]);
export const ModelsConfig = z
  .object({
    usd_to_gbp: z.number().positive(),
    /** Stamped on every cost event; bump when any price changes. */
    price_table_version: z.string().min(1),
    prices_checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    prices_source: z.url(),
    prices: z.record(
      z.string(),
      z.object({
        input_usd_per_mtok: z.number().min(0),
        output_usd_per_mtok: z.number().min(0),
        cache_read_usd_per_mtok: z.number().min(0).optional(),
        cache_write_5m_usd_per_mtok: z.number().min(0).optional(),
        cache_write_1h_usd_per_mtok: z.number().min(0).optional(),
        /** Above this many input tokens (all input, cache included) these prices apply instead. */
        long_context: z
          .object({
            over_input_tokens: z.number().int().positive(),
            input_usd_per_mtok: z.number().min(0),
            output_usd_per_mtok: z.number().min(0),
            cache_read_usd_per_mtok: z.number().min(0).optional(),
          })
          .optional(),
      }),
    ),
    roles: z.record(RoleName, z.object({ model: z.string().min(1), effort: Effort })),
  })
  .superRefine((c, ctx) => {
    for (const [role, r] of Object.entries(c.roles)) {
      if (!c.prices[r.model])
        ctx.addIssue({ code: "custom", path: ["roles", role], message: `no price for ${r.model}` });
    }
  });
export type ModelsConfig = z.infer<typeof ModelsConfig>;

export function loadModelsConfig(raw: unknown = modelsJson): ModelsConfig {
  return ModelsConfig.parse(raw);
}

export const InfraConfig = z.object({
  caps: z.object({
    global_per_day_gbp: z.number().positive(),
    per_playbook_per_day_gbp: z.record(z.string(), z.number().positive()),
    /**
     * Run-log steps left out of the daily caps: costs Archie approves himself (printing and postage
     * when he approves a batch). They still count in task cost and margins.
     */
    exclude_steps: z.array(z.string()).default([]),
    /** v2 Phase 3: daily cap per playbook at each tier above S0 (S0 = per_playbook_per_day_gbp). */
    spend_tiers: z
      .object({ S1: z.number().positive(), S2: z.number().positive(), S3: z.number().positive() })
      .refine((t) => t.S1 < t.S2 && t.S2 < t.S3, { message: "tiers must increase" }),
    /** Share of the weekly budget exploratory work may use (0–0.5). */
    explore_share: z.number().min(0).max(0.5),
    /** Held back before each model step, then settled at the real cost (labelled assumption). */
    step_reservation_gbp: z.number().positive(),
  }),
  /** v3 D2: value of Archie's time (OWNER_HOURLY_GBP). Labelled an assumption until Archie sets it. */
  owner: z.object({ hourly_gbp: z.number().positive(), hourly_is_assumption: z.boolean() }),
  kill_switch_default_on: z.boolean(),
  task_timeout_minutes: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  priority_by_revenue_path: z.record(z.string(), z.enum(["customer", "outreach", "internal"])),
  /** Which playbook an approved opportunity from each module runs. */
  playbook_for_module: z.record(z.string(), z.string()),
  outreach: z.object({
    followup_days: z.number().int().positive(),
    /** No new email or letter to a company contacted (or with one pending) within this many days. */
    contact_cooldown_days: z.number().int().min(0),
    /** Playbooks that count as contacting a company (across every module that feeds them). */
    contact_playbooks: z.array(z.string()).min(1),
    /** Copy rules every email and letter draft must pass (checked in code, not by the model). */
    copy_rules: z.object({
      max_observations: z.number().int().positive(),
      max_company_name_mentions: z.number().int().positive(),
      max_i_noticed: z.number().int().min(0),
      never_lead_with_fields: z.array(z.string()),
      never_lead_with_words: z.array(z.string()),
      offer_markers: z.array(z.string().min(2)).min(1),
      /** Truthful labelling (v2 rule 15): a sales approach may not pose as a survey, research or a personal note. */
      disguise_phrases: z.array(z.string().min(3)).min(1),
      min_sentences_before_offer: z.number().int().min(0),
    }),
    corporate_company_types: z.array(z.string()).min(1),
    opt_out_phrases: z.array(z.string()).min(1),
    contact_policy: z.record(
      z.string(),
      z.object({
        max_recipients_per_send: z.number().int().positive(),
        max_attempts_without_reply: z.number().int().positive(),
        min_days_between: z.number().min(0),
      }),
    ),
  }),
  autonomy: z.object({
    window: z.number().int().positive(),
    min_tasks: z.number().int().positive(),
    min_success: z.number().min(0).max(1),
    min_no_edit: z.number().min(0).max(1),
    max_breaches: z.number().int().min(0),
    l2_review_sample: z.number().min(0).max(1),
  }),
  /** Modules start in pilot (limited weekly volume) and go live only with backtest lift ≥ min_live_lift. */
  modules: z.object({
    pilot_weekly_limit: z.number().int().positive(),
    min_live_lift: z.number().positive(),
    calibration_min_closed: z.number().int().positive(),
    calibration_min_positives: z.number().int().positive(),
    calibration_blend: z.number().min(0).max(1),
  }),
  sender: z.object({
    name: z.string().min(1),
    company: z.string().min(1),
    address: z.string().min(1),
    from_email: z.string().min(3),
    opt_out_text: z.string().min(10),
    /**
     * Trading disclosures (Companies Act 2006 / Company Names regulations): printed on every letter,
     * email and web page we send or serve. Placeholders until cutover; real sends refuse to run while
     * the company number is the placeholder.
     */
    legal: z.object({
      registered_name: z.string().min(2),
      registered_in: z.string().min(2),
      company_number: z.string().regex(/^[A-Z0-9]{8}$/),
      registered_office: z.string().min(5),
    }),
    /** Printed at the foot of every letter (post isn't covered by PECR, but GDPR's right to object is). */
    letter_opt_out_text: z
      .string()
      .min(10)
      .refine((t) => ["{email}", "{code}", "{url}"].every((k) => t.includes(k)), {
        message: "the letter opt-out line must include {email}, {code} and {url}",
      }),
  }),
  /** v2 measurement: cold-start priors (assumptions), holdout, expected-value send gate. */
  measurement: z.object({
    priors: z.object({
      /** P(reply | sent) before any real outcomes. ASSUMPTION. */
      reply_rate: z.number().min(0).max(1),
      /** P(paid | reply) before any real outcomes. ASSUMPTION. */
      close_rate: z.number().min(0).max(1),
      /** £ a paying customer is worth in their first year (setup + 12 months). ASSUMPTION. */
      first_year_value_gbp: z.number().nonnegative(),
      /** How many sends the prior counts as (Beta pseudo-count): bigger = slower to move. */
      strength: z.number().positive(),
    }),
    /** Share of each outreach cohort sent to random, unranked eligible companies (0.10–0.20). */
    holdout_share: z.number().min(0.1).max(0.2),
    /** Send a letter only when EV ≥ k × letter cost. */
    letter_ev_k: z.number().positive(),
    email_send_cost_gbp: z.number().min(0),
    /** Skip letters to registered offices flagged as an accountant's/agent's (no trading address held). */
    skip_flagged_registered_offices: z.boolean(),
    /** A demo-page beacon updates the latest visit to that page within this window. */
    demo_visit_window_minutes: z.number().int().positive(),
  }),
  /** sme_letter: postal letters + demo homepage for leads we can't email. */
  letters: z.object({
    /** Playbook to use instead of these when a lead has no emailable address. */
    fallback_for: z.array(z.string()).min(1),
    playbook: z.string().min(1),
    /** Where demo pages are served (the QR code points here). Set a real host at cutover. */
    demo_base_url: z.url(),
    /** A new print batch is assembled at most this often. */
    batch_every_days: z.number().int().positive(),
    /** Demo pages stop working this many days after their batch is approved. */
    demo_expiry_days: z.number().int().positive(),
    /** Accountant/formation-agent registered offices: shared by ≥ this many companies → flag. */
    shared_address_threshold: z.number().int().min(2),
    accountant_keywords: z.array(z.string().min(2)).min(1),
    /** Per printed letter (paper, toner, envelope) and per stamp; added to the task's cost on approval. */
    print_cost_gbp: z.number().min(0),
    postage_gbp: z.number().min(0),
  }),
});
export type InfraConfig = z.infer<typeof InfraConfig>;
export function loadInfraConfig(raw: unknown = infraJson): InfraConfig {
  return InfraConfig.parse(raw);
}

export const ProductsConfig = z.object({
  x402: z.object({
    x402_version: z.literal(2),
    /** CAIP-2 network: eip155:84532 = Base Sepolia (testnet), eip155:8453 = Base mainnet. */
    network: z.string().regex(/^eip155:\d+$/),
    asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    asset_decimals: z.number().int().positive(),
    /** The token's EIP-712 domain (USDC: Base Sepolia "USDC"/"2"; Base mainnet "USD Coin"/"2"). */
    eip712: z.object({ name: z.string().min(1), version: z.string().min(1) }),
    max_timeout_seconds: z.number().int().positive(),
    prices_usd: z.object({ cached: z.number().positive(), premium: z.number().positive() }),
    cost_per_call_gbp: z.object({ cached: z.number().min(0), premium: z.number().min(0) }),
    facilitator_fee_gbp: z.number().min(0),
  }),
  monitoring: z.object({
    monthly_gbp: z.number().positive(),
    per_alert_gbp: z.number().positive(),
  }),
  human_check: z.object({ price_gbp: z.number().positive() }),
  /** v2 Phase 4: "claim this site" (setup fee + monthly subscription). Prices are Archie's to set. */
  claim_site: z.object({
    setup_fee_gbp: z.number().positive(),
    monthly_gbp: z.number().positive(),
    details_wait_days: z.number().int().min(1).max(365),
    publish_wait_days: z.number().int().min(1).max(365),
    human_minutes_target: z.number().positive(),
    base_url: z.string().url(),
    terms_version: z.string().min(1),
    terms: z.array(z.string().min(1)).min(3),
  }),
  blind_verifier: z.object({
    base_rate: z.number().gt(0).max(1),
    min_rate: z.number().gt(0).max(1),
    max_rate: z.number().gt(0).max(1),
    window: z.number().int().positive(),
    sensitivity: z.number().positive(),
  }),
});
export type ProductsConfig = z.infer<typeof ProductsConfig>;
export function loadProductsConfig(raw: unknown = productsJson): ProductsConfig {
  return ProductsConfig.parse(raw);
}

export const rawConfig = {
  products: productsJson,
  infra: infraJson,
  models: modelsJson,
  companies_house: chJson,
  universe: universeJson,
  confidence: confidenceJson,
  registry: registryJson,
  verification: verificationJson,
  triggers: triggersJson,
  decisions: decisionsJson,
  keys: keysJson,
  idea_categories: ideaCategoriesJson,
  idea_functions: ideaFunctionsJson,
  infra_prices: infraPricesJson,
  graph_policy: graphPolicyJson,
  ideas: ideasJson,
};

/** The company number used until Archie sets the real one (real sends refuse to run with it). */
export const PLACEHOLDER_COMPANY_NUMBER = "00000000";

/** One line with every trading disclosure, for letters, emails and web pages. */
export function tradingDisclosure(sender: InfraConfig["sender"]): string {
  const l = sender.legal;
  return `${l.registered_name}. Registered in ${l.registered_in}, company number ${l.company_number}. Registered office: ${l.registered_office}.`;
}

/** True while the trading details are still placeholders (blocks real sends). */
export function legalDetailsArePlaceholders(sender: InfraConfig["sender"]): boolean {
  return (
    sender.legal.company_number === PLACEHOLDER_COMPANY_NUMBER ||
    /placeholder/i.test(sender.legal.registered_office)
  );
}

const SectorCards = z.array(z.tuple([z.string().min(2), z.string().min(10)])).length(3);
export const SicSectors = z.object({
  sectors: z.array(
    z.object({
      key: z.string(),
      divisions: z.array(z.number().int().min(1).max(99)).min(1),
      label: z.string(),
      cards: SectorCards,
    }),
  ),
  default: z.object({ key: z.string(), label: z.string(), cards: SectorCards }),
});
export type SicSectors = z.infer<typeof SicSectors>;
export function loadSicSectors(raw: unknown = sicSectorsJson): SicSectors {
  return SicSectors.parse(raw);
}

/** Sector copy for a company's SIC codes (first code that matches a division), else the default. */
export function sectorFor(sicCodes: string[], sectors: SicSectors = loadSicSectors()) {
  for (const code of sicCodes) {
    const division = Number(String(code).slice(0, 2));
    const hit = sectors.sectors.find((s) => s.divisions.includes(division));
    if (hit) return hit;
  }
  return sectors.default;
}

/** Reactive trigger rules (v2 Phase 2): which change events act, and which may call the model. */
export const TriggerRule = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  kind: z.enum(["company", "filing", "officers", "psc", "charges", "insolvency"]),
  scope: z.enum(["universe", "opportunity", "watched_or_opportunity"]),
  /** Every key must match: the event's value (or any of its values) is one of the listed values. */
  match: z.record(z.string(), z.array(z.string()).min(1)),
  action: z.enum(["reverify", "reverify_and_alert", "explain"]),
  model: z.boolean(),
});
export type TriggerRule = z.infer<typeof TriggerRule>;
export const TriggersConfig = z
  .object({
    max_events_per_batch: z.number().int().min(1).max(10_000),
    fallback_poll: z.object({
      feed_stale_minutes: z.number().int().min(1),
      entities_per_poll: z.number().int().min(1).max(1000),
    }),
    rules: z.array(TriggerRule).min(1),
  })
  .refine((c) => new Set(c.rules.map((r) => r.id)).size === c.rules.length, {
    message: "rule ids must be unique",
  })
  .refine((c) => c.rules.every((r) => r.model === (r.action === "explain")), {
    message: "only the explain action calls the model, and it must say model: true",
  });
export type TriggersConfig = z.infer<typeof TriggersConfig>;
export function loadTriggersConfig(raw: unknown = triggersJson): TriggersConfig {
  return TriggersConfig.parse(raw);
}

/** v3 Needs-you queue: deadlines per decision type (hours), lead cap, digest hour. */
export const DecisionsConfig = z.object({
  deadline_hours: z.record(z.string(), z.number().positive()),
  max_open_leads: z.number().int().min(1).max(1000),
  digest_hour_utc: z.number().int().min(0).max(23),
  /** Runway (days) below which one "Top up or pause" decision opens (cockpit U3). */
  low_runway_days: z.number().positive().max(365).default(14),
});
export type DecisionsConfig = z.infer<typeof DecisionsConfig>;
/** v3 Phase 5: the key catalogue (names and dependants only; values never live in config). */
export const KeyEntry = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  label: z.string().min(1),
  host: z.string().min(1),
  purpose: z.string().min(1),
  model: z.boolean(),
  playbooks: z.array(z.string()),
  tools: z.array(z.string()),
});
export type KeyEntry = z.infer<typeof KeyEntry>;
export const KeysConfig = z
  .object({ keys: z.array(KeyEntry).min(1) })
  .refine((c) => new Set(c.keys.map((k) => k.name)).size === c.keys.length, "duplicate key name");
export type KeysConfig = z.infer<typeof KeysConfig>;
export function loadKeysConfig(raw: unknown = keysJson): KeysConfig {
  return KeysConfig.parse(raw);
}

/** The seeded ideas' categories → nearest node in brain/taxonomy.md (null = Archie to place). */
export const IdeaCategoriesConfig = z.object({
  categories: z.record(
    z.string().min(1),
    z.object({ node: z.string().min(1).nullable(), why: z.string().min(1) }),
  ),
});
export type IdeaCategoriesConfig = z.infer<typeof IdeaCategoriesConfig>;
export function loadIdeaCategoriesConfig(raw: unknown = ideaCategoriesJson): IdeaCategoriesConfig {
  return IdeaCategoriesConfig.parse(raw);
}

/** Per-idea function for ideas whose category has no single node. Every value is an estimate. */
export const IdeaFunctionsConfig = z.object({
  assigned_by: z.string().min(1),
  assigned_at: z.string().min(1),
  ideas: z.record(z.string().regex(/^I\d{3,}$/), z.string().min(1)),
});
export type IdeaFunctionsConfig = z.infer<typeof IdeaFunctionsConfig>;
export function loadIdeaFunctionsConfig(raw: unknown = ideaFunctionsJson): IdeaFunctionsConfig {
  return IdeaFunctionsConfig.parse(raw);
}
/** Categories that name an industry: an idea in one carries it as its market industry. */
export const INDUSTRY_CATEGORIES = [
  "Property and construction",
  "Professional services",
  "Local consumer businesses",
  "Traditional industries",
  "E-commerce and marketplaces",
] as const;

/** Cloudflare unit rates for allocating infra cost per step (graph plan, G0). */
export const InfraPricesConfig = z.object({
  price_table_version: z.string().min(1),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  plan_usd_per_month: z.number().min(0),
  rates: z.record(
    z.string(),
    z.object({
      usd_per_unit: z.number().min(0),
      included_per_month: z.number().min(0),
      source: z.string().min(1),
    }),
  ),
});
export type InfraPricesConfig = z.infer<typeof InfraPricesConfig>;
export function loadInfraPricesConfig(raw: unknown = infraPricesJson): InfraPricesConfig {
  return InfraPricesConfig.parse(raw);
}

/** Task graph policy: every bound lives here (graph plan). */
export const GraphPolicy = z.object({
  limits: z.object({
    max_nodes: z.number().int().min(1).max(100),
    max_depth: z.number().int().min(1).max(50),
    max_loop_iterations: z.number().int().min(1).max(10),
    max_fanout_width: z.number().int().min(1).max(50),
    max_fanout_items: z.number().int().min(1).max(1000),
    max_workflow_steps: z.number().int().min(1).max(10000),
    steps_per_node: z.number().int().min(1).max(10),
  }),
  sandbox: z.object({
    max_cost_per_attempt_gbp: z.number().positive(),
    max_cost_per_graph_gbp: z.number().positive(),
    max_attempts: z.number().int().min(1).max(10),
    max_probes: z.number().int().min(0).max(10),
    probe_max_nodes: z.number().int().min(1).max(25),
    min_failure_scenarios: z.number().int().min(1),
  }),
  runtime: z.object({
    approval_timeout_days: z.number().int().min(1).max(365),
    role_node_timeout_margin_s: z.number().int().min(0),
    role_node_timeout_max_s: z.number().int().min(60).max(1800),
    state_value_max_bytes: z.number().int().positive().max(1_048_576),
    budget_alert_thresholds: z.array(z.number().gt(0).max(1)).min(1),
  }),
  budget: z.object({ ev_share: z.number().gt(0).max(1) }),
  autonomy: z.object({ bespoke_max: z.enum(["L0", "L1", "L2", "L3"]) }),
  guardrails: z.object({
    outreach_send_tools: z.array(z.string().min(1)),
    untrusted_output_tools: z.array(z.string().min(1)),
  }),
  promotion: z.object({
    min_live_runs: z.number().int().min(1),
    max_breaches: z.number().int().min(0),
    wilson_z: z.number().positive(),
    min_success_lower_bound: z.number().min(0).max(1),
    /** A finished run is settled (its success metric read from the ledger) this many days after it ends. */
    settle_after_days: z.number().int().min(0),
  }),
});
export type GraphPolicy = z.infer<typeof GraphPolicy>;
export function loadGraphPolicy(raw: unknown = graphPolicyJson): GraphPolicy {
  return GraphPolicy.parse(raw);
}

export function loadDecisionsConfig(raw: unknown = decisionsJson): DecisionsConfig {
  return DecisionsConfig.parse(raw);
}

/** v3 Phase 6: scouting fields, idea-card cost model, test defaults (placeholders until Archie sets them). */
const KillCriterionCfg = z.object({
  metric: z.enum([
    "demo_visits_per_100_sends",
    "replies_per_100_sends",
    "paid_per_100_sends",
    "spend_gbp",
  ]),
  op: z.enum(["<", ">="]),
  threshold: z.number().finite(),
  by_day: z.number().int().min(1),
});
export const IdeasConfig = z.object({
  auto_start_test_gbp: z.number().nonnegative(),
  auto_start_is_assumption: z.boolean(),
  buyers: z.array(z.string().min(1)).min(1),
  fields: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        name: z.string().min(1),
        regulated: z.boolean(),
        sources: z
          .array(
            z.object({
              name: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
              lane: z.enum(["open", "licensed"]),
              reuse_allowed: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  cost_model: z.object({
    model_gbp_per_customer: z.number().nonnegative(),
    hosting_gbp_per_customer_year: z.number().nonnegative(),
    third_party_gbp_per_customer_year: z.number().nonnegative(),
    owner_minutes_per_customer: z.number().nonnegative(),
  }),
  test_defaults: z.object({
    sample_size: z.number().int().positive(),
    time_cap_days: z.number().int().positive(),
    budget_gbp: z.number().positive(),
    next_budget_step_gbp: z.number().nonnegative(),
  }),
  weekly_send_capacity_assumed: z.number().int().positive(),
  default_kill_criteria: z.array(KillCriterionCfg).min(1),
});
export type IdeasConfig = z.infer<typeof IdeasConfig>;
export function loadIdeasConfig(raw: unknown = ideasJson): IdeasConfig {
  return IdeasConfig.parse(raw);
}

export { BUILT_IN_LAYOUTS, loadLayout } from "./layouts/index.ts";
