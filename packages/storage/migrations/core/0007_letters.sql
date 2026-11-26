-- sme_letter: postal letters with a hosted demo homepage, printed by Archie in weekly batches.

-- One-page demo homepage per company. Served at /demo/<slug> (noindex) only once its letter's batch is
-- approved AND external actions are allowed for sme_letter (kill switch off).
CREATE TABLE demo_pages (
  slug TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  html TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX demo_pages_entity ON demo_pages (entity_id);

-- One print-ready letter per task (PDF bytes, base64). flags = review warnings, e.g. accountant_address.
CREATE TABLE letters (
  task_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  company_name TEXT NOT NULL,
  address TEXT NOT NULL,
  demo_slug TEXT NOT NULL REFERENCES demo_pages (slug),
  pdf_b64 TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('waiting', 'batched', 'approved', 'rejected')),
  batch_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX letters_status ON letters (status, created_at);
CREATE INDEX letters_batch ON letters (batch_id);

-- The weekly print batch Archie approves (or rejects). No print/post API yet: he prints the PDF.
CREATE TABLE print_batches (
  id TEXT PRIMARY KEY,
  week TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  letter_count INTEGER NOT NULL,
  flagged_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
