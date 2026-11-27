-- v4 Phase 1 (PLAN.md §2.1, §2.3): Opportunity = Problem × Segment × Route × Channel, its lifecycle,
-- distribution and the market packs. `market` is UK | US; `region` is a UK nation (ENG/SCO/WAL/NIR) or a
-- US state code. Links to the facts database (business_id, contact_id, fact ids) are plain text IDs,
-- checked in code: no foreign key crosses a database.

CREATE TABLE problems (
  problem_id TEXT PRIMARY KEY,
  industry_code TEXT NOT NULL,
  function TEXT NOT NULL,
  problem_slug TEXT NOT NULL,
  statement TEXT NOT NULL,
  evidence_fact_ids TEXT NOT NULL DEFAULT '[]',
  evidence_strength REAL NOT NULL DEFAULT 0 CHECK (evidence_strength BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'sensed' CHECK (status IN ('sensed', 'evidenced', 'retired')),
  markets_seen TEXT NOT NULL DEFAULT '[]',
  seed_hypothesis_ids TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (industry_code, function, problem_slug)
);
CREATE INDEX problems_map ON problems (industry_code, function);

CREATE TABLE segments (
  segment_id TEXT PRIMARY KEY,
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  industry_code TEXT,
  size_band TEXT,
  filters TEXT NOT NULL DEFAULT '{}',
  est_population INTEGER,
  population_source TEXT,
  as_of TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX segments_market ON segments (market, region);

CREATE TABLE routes (
  route_id TEXT PRIMARY KEY CHECK (route_id IN ('service_retainer', 'productised_tool', 'x402_api', 'marketplace_gig', 'digital_product')),
  template_graph TEXT,
  default_stage_caps TEXT NOT NULL DEFAULT '{}',
  cost_to_serve_model TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'planned', 'retired'))
);

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY CHECK (channel_id IN ('cold_email', 'marketplace_listing', 'seo_pages', 'agent_directory', 'x_content', 'partnership')),
  template_graph TEXT,
  allowed_markets TEXT NOT NULL DEFAULT '[]',
  compliance_pack_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('active', 'planned', 'retired'))
);

CREATE TABLE opportunities (
  opportunity_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  problem_id TEXT NOT NULL REFERENCES problems (problem_id),
  segment_id TEXT NOT NULL REFERENCES segments (segment_id),
  route_id TEXT NOT NULL REFERENCES routes (route_id),
  channel_id TEXT NOT NULL REFERENCES channels (channel_id),
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  stage TEXT NOT NULL DEFAULT 'sense' CHECK (stage IN ('sense', 'hypothesise', 'size', 'smoke_test', 'build_minimum', 'distribute', 'serve', 'measure', 'scale', 'killed', 'spawned')),
  bucket TEXT NOT NULL DEFAULT 'explore' CHECK (bucket IN ('exploit', 'adjacent', 'explore')),
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  compiled_graph TEXT,
  lane TEXT NOT NULL DEFAULT 'open' CHECK (lane IN ('open', 'paid_own_use', 'licensed')),
  parent_opportunity_id TEXT,
  hypothesis_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'running', 'paused', 'scaled', 'killed')),
  approval_id TEXT,
  spend_gbp REAL NOT NULL DEFAULT 0,
  revenue_gbp REAL NOT NULL DEFAULT 0,
  observed_cac_gbp REAL,
  observed_cost_to_serve_gbp REAL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, version)
);
CREATE INDEX opportunity_status ON opportunities (status, stage);
CREATE INDEX opportunity_market ON opportunities (market, region);
CREATE INDEX opportunity_problem ON opportunities (problem_id);

CREATE TABLE opportunity_stages (
  opportunity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  exited_at TEXT,
  cap_gbp REAL NOT NULL CHECK (cap_gbp >= 0),
  spent_gbp REAL NOT NULL DEFAULT 0,
  exit_result TEXT CHECK (exit_result IN ('passed', 'failed', 'killed', 'breaker')),
  evidence TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (opportunity_id, version, stage, entered_at),
  FOREIGN KEY (opportunity_id, version) REFERENCES opportunities (opportunity_id, version)
);

CREATE TABLE diagnoses (
  diagnosis_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('no_demand', 'wrong_channel', 'weak_offer', 'cost_to_serve_too_high', 'insufficient_data')),
  rule_id TEXT NOT NULL,
  inputs TEXT NOT NULL,
  respawn_opportunity_id TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id, version) REFERENCES opportunities (opportunity_id, version)
);
CREATE INDEX diagnoses_opportunity ON diagnoses (opportunity_id);

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('source_connector', 'template', 'domain', 'inbox', 'endpoint', 'page', 'dataset', 'prompt', 'eval_set', 'brief')),
  ref TEXT NOT NULL,
  market TEXT CHECK (market IN ('UK', 'US')),
  region TEXT,
  created_by_opportunity_id TEXT,
  reused_by TEXT NOT NULL DEFAULT '[]',
  marginal_cost_saved_gbp REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (kind, ref)
);

-- Archie's verdicts on contracts, gates, exceptions, promotions and budgets. Read by evals only, never by
-- an allocator (rule 12). Every verdict resolves through the one decisions path (rule 18).
CREATE TABLE judgements (
  judgement_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('opportunity_contract', 'stage_gate', 'exception', 'autonomy_promotion', 'budget')),
  subject_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'comment', 'defaulted')),
  reason TEXT,
  decision_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX judgements_subject ON judgements (subject_kind, subject_id);

CREATE TABLE market_packs (
  pack_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  compliance_rule_ids TEXT NOT NULL DEFAULT '[]',
  templates TEXT NOT NULL DEFAULT '{}',
  send_windows TEXT NOT NULL DEFAULT '{}',
  sending_domains TEXT NOT NULL DEFAULT '[]',
  locale TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('GBP', 'USD')),
  sandbox_report_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'tested', 'active')),
  config_hash TEXT NOT NULL,
  PRIMARY KEY (pack_id, version)
);

CREATE TABLE compliance_rules (
  rule_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  channel_id TEXT NOT NULL,
  check_fn TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  source_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  PRIMARY KEY (rule_id, version)
);

CREATE TABLE inboxes (
  inbox_id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  warmup_started_at TEXT,
  daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  health TEXT NOT NULL DEFAULT 'warming' CHECK (health IN ('warming', 'ok', 'paused')),
  created_at TEXT NOT NULL
);

CREATE TABLE touches (
  touch_id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  node_run_id TEXT,
  business_id TEXT NOT NULL,
  contact_id TEXT,
  channel_id TEXT NOT NULL REFERENCES channels (channel_id),
  inbox_id TEXT REFERENCES inboxes (inbox_id),
  market TEXT NOT NULL CHECK (market IN ('UK', 'US')),
  region TEXT,
  arm_id TEXT,
  price_arm TEXT,
  holdout INTEGER NOT NULL DEFAULT 0,
  basis TEXT NOT NULL CHECK (basis IN ('corporate_b2b', 'consent', 'existing_customer')),
  compliance_pack TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'bounced', 'complained', 'suppressed', 'blocked')),
  effect_key TEXT,
  dry_run INTEGER NOT NULL DEFAULT 1,
  synthetic INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (opportunity_id, version) REFERENCES opportunities (opportunity_id, version)
);
CREATE INDEX touches_opportunity ON touches (opportunity_id, status);
CREATE INDEX touches_business ON touches (business_id);
CREATE INDEX touches_inbox_day ON touches (inbox_id, sent_at);

CREATE TABLE replies (
  reply_id TEXT PRIMARY KEY,
  touch_id TEXT REFERENCES touches (touch_id),
  mail_message_id TEXT,
  class TEXT NOT NULL CHECK (class IN ('positive', 'question', 'not_now', 'opt_out', 'bounce', 'auto_reply', 'complaint')),
  class_method TEXT NOT NULL CHECK (class_method IN ('rule', 'llm')),
  routed_to TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL
);
CREATE INDEX replies_touch ON replies (touch_id);

-- Widened for v4 (market and region on everything that describes a send or money). Existing rows are
-- all UK (Companies House era): market defaults to 'UK'.
ALTER TABLE outcomes ADD COLUMN market TEXT NOT NULL DEFAULT 'UK';
ALTER TABLE outcomes ADD COLUMN region TEXT;
ALTER TABLE outcomes ADD COLUMN arm_id TEXT;
ALTER TABLE outcomes ADD COLUMN route_id TEXT;
ALTER TABLE outcomes ADD COLUMN channel_id TEXT;
ALTER TABLE cost_events ADD COLUMN stage TEXT;
ALTER TABLE cost_events ADD COLUMN cost_kind TEXT; -- acquisition | serve | build | overhead (checked by the contract)
ALTER TABLE cost_events ADD COLUMN market TEXT NOT NULL DEFAULT 'UK';
ALTER TABLE suppressions ADD COLUMN scope TEXT;
ALTER TABLE suppressions ADD COLUMN market TEXT;
ALTER TABLE suppressions ADD COLUMN source TEXT;
ALTER TABLE suppressions ADD COLUMN expires_at TEXT;
