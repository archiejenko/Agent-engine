-- 0005_phase4: x402 company check, payments ledger, blind verifier.

CREATE TABLE x402_requests (
  id TEXT PRIMARY KEY,
  company_number TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('cached', 'premium')),
  status TEXT NOT NULL CHECK (status IN ('challenge', 'invalid_payment', 'served', 'not_found', 'failed', 'settle_failed')),
  price_usd REAL NOT NULL,
  price_gbp REAL NOT NULL,
  cost_gbp REAL NOT NULL,
  payer TEXT,
  transaction_ref TEXT,
  network TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX x402_requests_company ON x402_requests (company_number, created_at);

CREATE INDEX x402_requests_time ON x402_requests (created_at, status);

-- Every payment settled (fake ledger in dry-run; real transaction refs after cutover).
CREATE TABLE payments_ledger (
  id TEXT PRIMARY KEY,
  rail TEXT NOT NULL CHECK (rail IN ('x402', 'stripe')),
  reference TEXT NOT NULL UNIQUE,
  payer TEXT,
  amount_gbp REAL NOT NULL,
  currency_amount TEXT NOT NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  task_id TEXT,
  created_at TEXT NOT NULL
);

-- Blind verifier: re-derived values compared with stored facts, without seeing the original claims.
CREATE TABLE blind_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  source TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  fresh_value TEXT,
  agree INTEGER NOT NULL CHECK (agree IN (0, 1)),
  checked_at TEXT NOT NULL
);

CREATE INDEX blind_checks_pair ON blind_checks (source, field, checked_at);
