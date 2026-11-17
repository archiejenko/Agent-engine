---
type: build-report
phase: v3-4
date: 2026-11-17
status: gate passed (synthetic)
---

# v3 Phase 4: Vault (gate report)

## What was built

**The Vault page** (`/vault`) reads every note in `brain/`:
- search by words in the note and by tag;
- each note shows its front matter, the links out of it and the notes that link back to it
  (`[[wikilinks]]` and ordinary relative Markdown links both count);
- you can edit a note from the page.

**Where notes come from.** Git holds the notes. On Cloudflare the Worker can't read the repo, so
`pnpm cf:deploy` now bundles `brain/` into the Worker first (`pnpm gen:brain`). Locally the API reads the
folder directly.

**Edits are versions, never overwrites (v3 rule 21).** Every edit, yours or an agent's, is a new row in
`note_versions` (migration 0016). Nothing is ever updated in place, and the page shows the full history.
- A note edited on the page is labelled **"edited here, not yet in git"** until it's committed.
- An agent's note **must** carry provenance or it's refused:
  - who wrote it, and when;
  - which sources or ledger rows it rests on.
- Labels carry through. A note built from a website shows **untrusted**.
- Nothing writes agent notes yet. That's Milestone D; this phase builds and tests the rule it has to follow.

**The ideas sheet.** `/vault/ideas` shows `brain/ideas/seed-500.csv` with your columns. Every score is
labelled **(assumed)** (v3 rule 23). A static test checks that no scoring, targeting or learning code
reads the sheet.

**The file isn't on the branch yet.** The page says so and lists the columns it expects. The gate uses a
three-row fixture with your exact columns. Add the real file to `brain/ideas/` and it appears after the
next deploy.

## Gate (`docs/gates/v3-phase4.md`, run with `pnpm gate:v3 --phase 4`)

| Criterion | Status |
|---|---|
| Search finds a note by its content (and by tag) | passed (synthetic) |
| Links and backlinks resolve | passed (synthetic) |
| An agent write creates a new version rather than replacing yours | passed (synthetic) |
| Provenance on every agent-written note; a note without it is refused; labels carry through | passed (synthetic) |
| The ideas sheet shows with every score labelled assumed | passed (synthetic) |

**Other tests:**
- The phone layout test now covers the Vault list, a note and the ideas sheet at 390px and 1440px.
- New static test: the ideas sheet is never read by scoring code.

## Things to know

- **Committing an edit.** An edit made on the page lives in D1 until someone commits it to `brain/`.
  The page shows the latest text either way.
- **Writing `brain/status-and-vision.md`.** It is a stub marked "To write (Archie)", so the Vault has
  something to link to.

Next: Phase 5 (Controls and Keys).
