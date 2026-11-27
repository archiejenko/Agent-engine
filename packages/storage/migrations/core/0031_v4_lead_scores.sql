-- v4 Phase 1 (PLAN.md §0.7, approved 2026-11-27): the Phase 2 per-company scored leads move to
-- lead_scores, so `opportunities` can be the portfolio-level object (0032). Data is kept as it is.
ALTER TABLE opportunities RENAME TO lead_scores;
DROP INDEX opportunities_queue;
DROP INDEX opportunities_entity;
CREATE INDEX lead_scores_queue ON lead_scores (status, module, rank);
CREATE INDEX lead_scores_entity ON lead_scores (entity_id);
