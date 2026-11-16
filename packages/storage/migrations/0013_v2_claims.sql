-- v2 Phase 4: "claim this site" (setup fee + monthly subscription) and events sent to waiting workflows.

-- Events for workflow steps that wait (details form submitted, publish approved, cancelled). Locally the
-- engine reads them; on Cloudflare they're also sent to the instance with sendEvent.
CREATE TABLE workflow_events (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  received_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX workflow_events_waiting ON workflow_events (instance_id, type, consumed_at);

CREATE TABLE site_claims (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  -- The outreach task (letter or email) that earned it: attribution for the ledger.
  source_task_id TEXT,
  -- The fulfilment task (playbook claim_site), created when payment arrives.
  task_id TEXT,
  email TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL CHECK (status IN ('checkout_started', 'paid', 'details_received', 'awaiting_publish', 'published', 'cancelled', 'refunded')),
  session_id TEXT UNIQUE,
  subscription_id TEXT,
  workflow_id TEXT,
  details TEXT,
  details_token TEXT UNIQUE NOT NULL,
  terms_version TEXT NOT NULL,
  setup_fee_gbp REAL NOT NULL,
  monthly_gbp REAL NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX site_claims_subscription ON site_claims (subscription_id);
CREATE INDEX site_claims_slug ON site_claims (slug);
