-- Archie's answer (2026-11-18): every idea gets a FUNCTION (a node in brain/taxonomy.md, or 'own product')
-- and a MARKET (the buyer, plus the industry where the category names one).
-- function_source: 'category' (inherited from a mapped category) | 'estimate' (assigned per idea from its
-- text; to spot-check) | 'set' (changed by Archie or an agent; a re-import then leaves it alone).
ALTER TABLE hypotheses ADD COLUMN function TEXT;
ALTER TABLE hypotheses ADD COLUMN function_source TEXT;
ALTER TABLE hypotheses ADD COLUMN function_changed_by TEXT;
ALTER TABLE hypotheses ADD COLUMN market_buyer TEXT;
ALTER TABLE hypotheses ADD COLUMN market_industry TEXT;
CREATE INDEX hypotheses_function ON hypotheses (function);
