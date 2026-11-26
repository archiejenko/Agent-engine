-- Reverses 0027_bodies (local and test use only).
ALTER TABLE note_versions DROP COLUMN body_sha256;
ALTER TABLE note_versions DROP COLUMN body_size;
ALTER TABLE note_versions DROP COLUMN body_key;
ALTER TABLE mail_messages DROP COLUMN body_sha256;
ALTER TABLE mail_messages DROP COLUMN body_size;
ALTER TABLE mail_messages DROP COLUMN body_key;
ALTER TABLE outbox DROP COLUMN body_sha256;
ALTER TABLE outbox DROP COLUMN body_size;
ALTER TABLE outbox DROP COLUMN body_key;
ALTER TABLE demo_pages DROP COLUMN html_sha256;
ALTER TABLE demo_pages DROP COLUMN html_size;
ALTER TABLE demo_pages DROP COLUMN html_key;
ALTER TABLE letters DROP COLUMN pdf_b64_sha256;
ALTER TABLE letters DROP COLUMN pdf_b64_size;
ALTER TABLE letters DROP COLUMN pdf_b64_key;
