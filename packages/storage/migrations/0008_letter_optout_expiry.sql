-- Demo pages expire a fixed time after their batch is approved; letters carry a short opt-out code.
ALTER TABLE demo_pages ADD COLUMN published_at TEXT;
ALTER TABLE letters ADD COLUMN opt_out_code TEXT;
CREATE UNIQUE INDEX letters_opt_out_code ON letters (opt_out_code);
