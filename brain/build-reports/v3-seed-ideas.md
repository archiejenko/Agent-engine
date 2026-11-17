---
type: build-report
phase: v3-4 (seeded ideas)
date: 2026-11-17
status: gate passed; Ideas feed and Board wait for Phase 6
---

# Seeded ideas: `seed-500.csv` as the hypothesis backlog (gate report)

You asked for everything that belongs to Phases 1–5 now, with the Ideas feed and the Board in Phase 6.
That's what's built. Milestone D is on hold.

## What was built

- **The file** is committed at `brain/ideas/seed-500.csv`, unchanged: 500 rows, `I001`–`I500`.
- **Import** (Vault → Ideas sheet → "Import into the backlog", or `POST /api/vault/ideas/import`):
  - Each row becomes a **hypothesis**, keyed on its `id`.
  - Each hypothesis holds the category, its taxonomy node, buyer, revenue model, why now, batch and the
    six scores.
  - The stage is "proposed", or "live" where the file says Built.
- **Score and matrix are recomputed in code**; the file's values are only compared.
  - **Score** = the weighted points divided by 5 (weights 25/20/20/15/10/10). It's always a whole number,
    so no rounding is involved.
  - **Matrix**:
    - "value" is the average of demand and margin;
    - "feasibility" is the average of autonomy, speed to cash, ease of build and low risk;
    - 4 or more counts as high on either.
  - All 500 rows agree with the file.
- **Re-import is idempotent on `id`.** Text and scores follow the file. It **never overwrites**:
  - your decision or comments;
  - a stage you or an agent changed.

  A decision typed into the sheet is taken only when the idea has no decision yet.
- **Validation rejects the whole file and names the rows.** It checks:
  - scores are whole numbers from 1 to 5;
  - the matrix, status, batch and decision values are known ones;
  - no `id` appears twice;
  - every category is one of the 25;
  - `score_source` is `estimate`.

  If any row fails, nothing is written.
- **Scores are estimates (rule 23).**
  - Every score is labelled `estimate` wherever it's shown, and the database only accepts `estimate`.
  - Changing a score records the new value, who changed it, when and why, and keeps the full history.
    Score and matrix are recomputed after each change.
  - Seeded scores never reach the outcome ledger, P(paid), the Home figures or any scoring code. Two
    static tests and a behavioural check enforce that.
- **Vault → Ideas sheet**:
  - every row with search and filters (category, matrix, batch);
  - recomputed score and matrix, and the six scores labelled estimate;
  - the taxonomy node for each category;
  - a **link to each idea's card** (`#/ideas/I001`). For now that link explains the card arrives in Phase 6.
  - A rejected file shows which rows to fix.
- **Ready for Phase 6:**
  - Pass / Fail / Question is stored on the hypothesis. In Phase 6 it is applied through the one decisions
    path; no page or route sets it yet.
  - A Fail stores a fingerprint of the idea's text and scores, so an unchanged failed idea can't be raised
    again.

## Gate (`docs/gates/v3-seed.md`, run with `pnpm gate:v3 --phase seed`)

| Criterion | Status |
|---|---|
| A 10-row fixture imports cleanly (real rows, including quoted cells and a Built row) | passed |
| Re-import after you mark one idea Fail keeps your decision (and comments, and a stage an agent changed) | passed |
| A row with a score of 6 is rejected; the whole file is refused and the row is named | passed |
| Recomputed score and matrix match the file for all 500 rows | passed |
| No seeded score appears in any learning or scoring query (P(paid), Home figures and the ledger are byte-for-byte unchanged after importing 500 and editing a score; static tests) | passed |
| Each category maps to the nearest taxonomy node, or is listed below | passed |
| The Vault shows the file with a link to each idea's card | passed |

## Categories I couldn't map: please place these

`brain/taxonomy.md` lists 16 **business functions**. Eleven of the 25 categories are industries, sales
channels or product types, so I left them unmapped rather than guess. Mapping lives in
`packages/config/src/idea-categories.json`. Set `node` there, or add nodes to the taxonomy.

| Category | Why it isn't mapped |
|---|---|
| Back-office automation | spans finance, HR and operations admin |
| Monitoring and alerts | a product type; what is monitored decides the function |
| Traditional industries | an industry group |
| Professional services | an industry group |
| Local consumer businesses | an industry group |
| Property and construction | an industry (not the facilities function) |
| E-commerce and marketplaces | a sales channel and industry |
| Digital products and content | a product type |
| Agent-readiness for SMEs | new; no node fits yet |
| x402 utility tools | a sales channel (paid calls from AI agents) |
| x402 data APIs | a sales channel (paid calls from AI agents) |

**Mapped (14):**
- **Sales:** Sales operations and bids; Leads sold to other firms.
- **Marketing:** SME websites.
- **Customer service and success:** Customer service and complaints.
- **Operations and delivery:** Operations and field service.
- **Finance:** Finance and accounts.
- **Legal, risk and compliance:** Compliance and deadlines; Legal and company secretarial; Health, safety,
  quality and environment.
- **HR:** HR and people admin.
- **Procurement:** Purchasing and supply chain.
- **IT and security:** Documents, data and IT admin.
- **Data and analytics:** One-off data reports.
- **Facilities and property:** Facilities, fleet and assets.

Three of these are judgement calls, each noted in the config:
- HSQE → compliance, though "environment" could arguably sit under ESG;
- purchasing → procurement, though supply chain could arguably sit under logistics;
- fleet → facilities, though it could arguably sit under logistics.

Please confirm or change these.

## One question for you

The brief says a re-import "updates text and scores". So if you or an agent changes a score on the
dashboard and the sheet still has the old value, the next import puts the sheet's value back. It does keep
both values in the history, and decisions, comments and stages are protected as asked. If you'd rather
dashboard score changes also survive a re-import, it's a one-line change. Tell me which you want.

## Not built yet (Phase 6, as you asked)

- the Ideas feed of cards;
- the Board;
- Pass / Fail / Question buttons;
- re-raise blocking in the feed.

The data, history and fingerprint they need are already in place.
