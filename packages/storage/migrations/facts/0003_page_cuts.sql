-- Per-page text limit for the website extractor (2026-11-27): each page sent to the model is cut to a
-- token budget (packages/config verification.json). Every cut is recorded here with the page's size
-- before and after, so a run shows which pages the model didn't see in full.
CREATE TABLE page_cuts (
  run_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  url TEXT NOT NULL,
  original_tokens INTEGER NOT NULL,
  kept_tokens INTEGER NOT NULL,
  cut_at TEXT NOT NULL,
  PRIMARY KEY (run_id, entity_id, url)
) WITHOUT ROWID;
