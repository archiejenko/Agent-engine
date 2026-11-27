-- Reverses 0031_v4_lead_scores (local and test use only).
DROP INDEX lead_scores_queue;
DROP INDEX lead_scores_entity;
ALTER TABLE lead_scores RENAME TO opportunities;
CREATE INDEX opportunities_queue ON opportunities (status, module, rank);
CREATE INDEX opportunities_entity ON opportunities (entity_id);
