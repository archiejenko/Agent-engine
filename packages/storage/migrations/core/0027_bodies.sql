-- Data layer plan, step 3: large bodies go to R2 (agent-engine-files) through one helper
-- (packages/storage/src/bodies.ts). Each body column keeps its name and holds the text inline when it's
-- 8 KiB or less, or '' when the body is in R2; these columns say where it is and check it on read.
-- Letter PDFs (as bytes) and demo pages always go to R2.
ALTER TABLE letters ADD COLUMN pdf_b64_key TEXT;
ALTER TABLE letters ADD COLUMN pdf_b64_size INTEGER;
ALTER TABLE letters ADD COLUMN pdf_b64_sha256 TEXT;
ALTER TABLE demo_pages ADD COLUMN html_key TEXT;
ALTER TABLE demo_pages ADD COLUMN html_size INTEGER;
ALTER TABLE demo_pages ADD COLUMN html_sha256 TEXT;
ALTER TABLE outbox ADD COLUMN body_key TEXT;
ALTER TABLE outbox ADD COLUMN body_size INTEGER;
ALTER TABLE outbox ADD COLUMN body_sha256 TEXT;
ALTER TABLE mail_messages ADD COLUMN body_key TEXT;
ALTER TABLE mail_messages ADD COLUMN body_size INTEGER;
ALTER TABLE mail_messages ADD COLUMN body_sha256 TEXT;
ALTER TABLE note_versions ADD COLUMN body_key TEXT;
ALTER TABLE note_versions ADD COLUMN body_size INTEGER;
ALTER TABLE note_versions ADD COLUMN body_sha256 TEXT;
