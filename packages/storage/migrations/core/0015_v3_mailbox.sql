-- v3 Phase 3: the outreach mailbox (a dedicated address on the sending domain, never Archie's inbox).
-- Inbound replies arrive through Cloudflare Email Routing into the Worker (or the local fake inbox);
-- agents can list, read and draft here, never send (sending stays in the tool registry behind approval).
CREATE TABLE mail_messages (
  id TEXT PRIMARY KEY,
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'drafts')),
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  -- The outbox email this answers (from In-Reply-To or the replies+<outbox id>@ subaddress).
  in_reply_to TEXT,
  entity_id TEXT,
  task_id TEXT,
  -- Inbound mail is untrusted content: data for models, never instructions.
  untrusted INTEGER NOT NULL DEFAULT 1,
  author TEXT,
  received_at TEXT NOT NULL,
  synthetic INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX mail_messages_folder ON mail_messages (folder, received_at);
CREATE INDEX mail_messages_entity ON mail_messages (entity_id);
