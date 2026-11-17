# Phase v3-4 gate report

Generated 2026-11-17T20:45:32.004Z on SYNTHETIC data with fake external systems.

| Criterion | Status | Evidence |
|---|---|---|
| Search finds a note by its content (and by tag) | passed (synthetic) | "zebra" (only in the body) → brain/frameworks/pricing.md; tag "pricing" → 1 note |
| Links and backlinks resolve ([[wikilinks]] and relative markdown links) | passed (synthetic) | pricing.md links to brain/lessons.md, brain/build-reports/plan.md; lessons.md backlinks: brain/frameworks/pricing.md; plan.md backlinks: brain/frameworks/pricing.md |
| An agent write creates a new version rather than replacing Archie's | passed (synthetic) | history of lessons.md: v1 archie, v2 agent:coordinator; Archie's text is still v1, untouched |
| Provenance is present on every agent-written note (and labels carry through) | passed (synthetic) | 2 agent versions, each with author, time and sources/ledger rows; a note without provenance was refused ("an agent note needs its provenance: at least one source or ledger row"); the note built on a website shows "untrusted" |
| The ideas sheet shows in the Vault with every score labelled assumed | passed (synthetic) | fixture sheet with Archie's columns: 3 rows, all labelled assumed; quoted cells parsed; scoring code never reads it (tests/architecture.test.ts) |

Synthetic data, fakes only, kill switch on. Nothing external happened.
