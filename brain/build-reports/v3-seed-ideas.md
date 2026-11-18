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
- **Re-import is idempotent on `id`.** Text follows the file, and so do scores nobody has changed. It
  **never overwrites**:
  - a score you or an agent changed;
  - your decision or comments;
  - a stage or function someone changed.

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
| A score changed on the dashboard survives a re-import; both values stay in the history | passed |
| Every idea has a function (taxonomy node or own product) and a market | passed |
| A row with a score of 6 is rejected; the whole file is refused and the row is named | passed |
| Recomputed score and matrix match the file for all 500 rows | passed |
| No seeded score appears in any learning or scoring query (P(paid), Home figures and the ledger are byte-for-byte unchanged after importing 500 and editing a score; static tests) | passed |
| Each category maps to the nearest taxonomy node, or is listed below | passed |
| The Vault shows the file with a link to each idea's card | passed |

## Your answers (2026-11-18), now built

**1. Score edits stick.** After the first import, the dashboard is the record. A re-import:
- adds new ideas and updates text;
- updates a score only if nobody has changed it since import;
- **never overwrites a score that you or an agent changed**.

Both values stay in the history. The import reports how many changed scores it kept. Decisions, comments,
a stage someone changed, and a function someone set are protected the same way.

**2. Every idea has a function and a market.**
- **Function** is a node in `brain/taxonomy.md`, or **own product**. 280 ideas in the 14 mapped categories
  inherit their category's node; your three judgement calls are approved. The other **220 ideas** each
  carry a function I assigned from the idea's text (`packages/config/src/idea-functions.json`). Every one
  is labelled **estimate** and listed below for you to spot-check. To correct one, edit that file and
  re-import. A function set later on the dashboard (Phase 6) survives re-imports.
- **Market** is the buyer column, plus the industry where the category names one (Property and
  construction, Professional services, Local consumer businesses, Traditional industries, E-commerce and
  marketplaces). That's 100 ideas.
- **Filters:** Vault → Ideas sheet filters by function and by market now. Idea cards and the Board get the
  same filters in Phase 6.

How the 220 split: own product 66, sales 53, marketing 23, legal, risk and compliance 14, finance 15, customer service and success 14, operations and delivery 8, procurement 7, strategy and M&A 6, data and analytics 3, HR 4, IT and security 3, facilities and property 2, product and R&D 1, supply chain and logistics 1.

### Per-idea functions (all estimates)

**Spot-checked by Archie on 2026-11-18.** I217 and I239 were changed to "own product"; I220 and the other
217 were kept as assigned. They stay labelled estimate, because they're still judgements, not outcomes.

**Agent-readiness for SMEs**

| ID | Idea | Function (estimate) |
|---|---|---|
| I041 | llms.txt and structured data setup | marketing |
| I042 | Automated agent-readiness audit report | marketing |
| I043 | Product feed formatting for AI shopping agents | sales |
| I044 | Monthly 'can AI find you' visibility monitoring | marketing |
| I045 | Google Business Profile optimisation and upkeep | marketing |
| I046 | FAQ and policy pages written for agents to read | customer service and success |
| I047 | Agentic checkout enablement for Shopify stores | sales |
| I048 | AI answer-engine citation tracking report | marketing |
| I049 | Booking wrapper so agents can book appointments | sales |
| I050 | Restaurant menu and price data in machine-readable form | marketing |
| I051 | Trades service catalogue with machine-readable pricing | sales |
| I052 | Review response automation | customer service and success |
| I053 | Opening hours and listing consistency fixer | marketing |
| I054 | WebMCP endpoint setup for SME sites | IT and security |
| I055 | Competitor AI-visibility benchmark report | marketing |
| I056 | Structured data subscription that updates itself | marketing |
| I057 | Image descriptions at scale for product catalogues | marketing |
| I058 | Local comparison content that agents cite | marketing |
| I059 | Agent-traffic analytics for SME sites | data and analytics |
| I060 | Agent-readable returns and warranty policy generator | customer service and success |

**Back-office automation**

| ID | Idea | Function (estimate) |
|---|---|---|
| I281 | Invoice chasing sequences | finance |
| I282 | Late-payment interest claim drafting | finance |
| I283 | Supplier statement reconciliation | finance |
| I284 | Expense receipt matching | finance |
| I285 | Cash-flow forecast from a bank feed | finance |
| I286 | Payroll query responder | HR |
| I287 | Purchase order approval workflow | procurement |
| I288 | Contract renewal date tracker | procurement |
| I289 | Software subscription spend audit | procurement |
| I290 | Utility bill audit and switching prompt | procurement |
| I291 | Risk-ranked debtor chase list using company data | finance |
| I292 | Quote follow-up automation | sales |
| I293 | Meeting notes to actions and CRM updates | sales |
| I294 | Inbox triage for owner-managers | operations and delivery |
| I295 | Staff rota builder | HR |
| I296 | Onboarding pack generator for new hires | HR |
| I297 | Board pack and KPI summary from accounting software | finance |
| I298 | Bid library with answer reuse | sales |
| I299 | Win-back campaigns for dormant customers | marketing |
| I300 | Grant application first drafts | finance |

**Digital products and content**

| ID | Idea | Function (estimate) |
|---|---|---|
| I221 | Niche local business directories with paid featured slots | own product |
| I222 | Sector newsletters with sponsor slots, curated from filings | own product |
| I223 | Contract and policy template packs | own product |
| I224 | Monthly 'state of business in your town' data report | own product |
| I225 | Paid compliance deadline trackers | own product |
| I226 | Prompt and playbook packs for SME owners | own product |
| I227 | Software comparison pages for trades with affiliate links | own product |
| I228 | Tender-writing template library | own product |
| I229 | Short courses generated from new regulations | own product |
| I230 | Industry glossary sites funded by ads | own product |
| I231 | Datasets sold on a data marketplace | own product |
| I232 | Niche trade job board | own product |
| I233 | Weekly 'new companies in your sector' paid digest | own product |
| I234 | Business calculators with an upsell | own product |
| I235 | Local events aggregator with promoted listings | own product |
| I236 | Benchmark reports per trade from filed accounts | own product |
| I237 | Audio briefings made from weekly data | own product |
| I238 | E-book series on selling to a sector, with live data | own product |
| I239 | Open-data dashboards licensed to councils and business districts | own product (changed by Archie, 2026-11-18) |
| I240 | Paid data connector: UK business data for AI assistants | own product |

**E-commerce and marketplaces** (market industry: this category)

| ID | Idea | Function (estimate) |
|---|---|---|
| I261 | Product listing rewriting at scale | marketing |
| I262 | Abandoned basket sequences for small stores | sales |
| I263 | Returns and refund request triage | customer service and success |
| I264 | Marketplace price and stock monitoring | sales |
| I265 | Customer service inbox autopilot | customer service and success |
| I266 | Print-on-demand designs for niche trades | own product |
| I267 | Template download shop across marketplaces | own product |
| I268 | Wholesale lead finder for product brands | sales |
| I269 | Review mining to product improvement report | product and R&D |
| I270 | Supplier sourcing comparison report | procurement |
| I271 | Managed product feed for agentic checkout | sales |
| I272 | Subscription box pages for local producers | sales |
| I273 | Marketplace listing compliance checker | legal, risk and compliance |
| I274 | Product image background and variant generation | marketing |
| I275 | Reorder reminders for trade customers | sales |
| I276 | Affiliate storefronts for tools used by trades | own product |
| I277 | Commodity code lookup helper for exporters | supply chain and logistics |
| I278 | Seller health-report subscription | data and analytics |
| I279 | Gift card and voucher page for local shops | sales |
| I280 | Agent-run dropship niche stores | own product |

**Local consumer businesses** (market industry: this category)

| ID | Idea | Function (estimate) |
|---|---|---|
| I181 | Restaurants: review replies and menu updates | customer service and success |
| I182 | Restaurants: allergen matrix generator | legal, risk and compliance |
| I183 | Pubs: events page and listings syndication | marketing |
| I184 | Cafes: QR ordering and loyalty page | sales |
| I185 | Hotels and B&Bs: direct booking page to cut platform fees | sales |
| I186 | Salons and barbers: no-show reminders and rebooking | customer service and success |
| I187 | Dentists: recall reminders and plan sign-up page | customer service and success |
| I188 | Opticians and physios: appointment FAQ assistant | customer service and success |
| I189 | Gyms and studios: lapsed-member win-back sequences | marketing |
| I190 | Independent retailers: product catalogue for AI shopping agents | sales |
| I191 | Florists and bakers: occasion pre-order pages | sales |
| I192 | Vets: vaccination reminder automation | customer service and success |
| I193 | Care homes: enquiry response and brochure pack | sales |
| I194 | Nurseries: waiting list and inspection summary page | sales |
| I195 | Takeaways: own ordering page to cut platform fees | sales |
| I196 | Beauty and tattoo: consent forms and aftercare messages | legal, risk and compliance |
| I197 | Pharmacies: service booking page | sales |
| I198 | Wedding venues: availability and quote responder | sales |
| I199 | Holiday parks: seasonal availability pages | sales |
| I200 | Market traders: simple online shop from a photo list | sales |

**Monitoring and alerts**

| ID | Idea | Function (estimate) |
|---|---|---|
| I121 | Customer and supplier company watch (already built) | legal, risk and compliance |
| I122 | Competitor filing and hiring tracker | strategy and M&A |
| I123 | Credit-risk change alerts on a debtor list | finance |
| I124 | Tenant company health watch for landlords | finance |
| I125 | Director-change alerts on key clients | sales |
| I126 | Tender alerts by sector | sales |
| I127 | Planning application alerts near an address | facilities and property |
| I128 | Review and reputation alerts | marketing |
| I129 | Competitor price-change monitoring | strategy and M&A |
| I130 | Website uptime and certificate expiry monitoring | IT and security |
| I131 | Brand name and trademark watch | legal, risk and compliance |
| I132 | Regulatory change digest by sector | legal, risk and compliance |
| I133 | Grant and funding alerts by sector and region | finance |
| I134 | Supply-chain insolvency early warning | procurement |
| I135 | Franchisee health dashboard for franchisors | operations and delivery |
| I136 | Portfolio company watch for investors | strategy and M&A |
| I137 | Domain expiry and lookalike-domain watch | IT and security |
| I138 | New competitor incorporations in your area and trade | strategy and M&A |
| I139 | Salary benchmark alerts from job ads | HR |
| I140 | Gazette notice alerts for credit controllers | finance |

**Professional services** (market industry: this category)

| ID | Idea | Function (estimate) |
|---|---|---|
| I161 | Accountants: white-label client deadline reminders | customer service and success |
| I162 | Accountants: Making Tax Digital onboarding sequences | customer service and success |
| I163 | Accountants: monthly new-incorporation prospect list | sales |
| I164 | Solicitors: enquiry triage and conflict pre-check | sales |
| I165 | Solicitors: fixed-fee service pages with intake forms | marketing |
| I166 | Estate agents: vendor lead list from property signals | sales |
| I167 | Estate agents: listing descriptions and social packs | marketing |
| I168 | Recruiters: client hiring-signal digest | sales |
| I169 | Financial advisers: compliant newsletter drafting | marketing |
| I170 | Architects: planning precedent research pack | operations and delivery |
| I171 | Surveyors: comparable evidence pack | operations and delivery |
| I172 | Marketing agencies: white-label site audit reports | operations and delivery |
| I173 | IT support firms: prospect security posture report | sales |
| I174 | Bookkeepers: receipt chasing automation | operations and delivery |
| I175 | Consultants: proposal first drafts from a brief | sales |
| I176 | HR consultancies: policy update alerts for their clients | operations and delivery |
| I177 | Insurance brokers: renewal reminder sequences | sales |
| I178 | Commercial agents: tenant financial strength report | operations and delivery |
| I179 | Business brokers: valuation teaser from filed accounts | sales |
| I180 | Translation agencies: instant quote widget | sales |

**Property and construction** (market industry: this category)

| ID | Idea | Function (estimate) |
|---|---|---|
| I201 | Planning refusal leads for appeal consultants | sales |
| I202 | Landlords: Making Tax Digital record pack | finance |
| I203 | Landlords: energy rating upgrade requirement report | legal, risk and compliance |
| I204 | Letting agents: compliance certificate expiry tracker | legal, risk and compliance |
| I205 | Builders: tender document summariser | sales |
| I206 | Builders: subcontractor verification reminders | procurement |
| I207 | Developers: site-finding report from planning and land data | strategy and M&A |
| I208 | Block managers: service charge query responder | customer service and success |
| I209 | Commercial landlords: rent review comparables alert | finance |
| I210 | Property investors: auction lot due-diligence pack | strategy and M&A |
| I211 | Serviced offices: availability feed for AI agents | sales |
| I212 | Construction: method statement first drafts | legal, risk and compliance |
| I213 | Roofers and solar installers: suitability report by address | sales |
| I214 | Self-storage: dynamic pricing page | sales |
| I215 | HMO licence checker by postcode | legal, risk and compliance |
| I216 | Short-let hosts: listing optimisation and pricing notes | marketing |
| I217 | Plain-English building rules guide per project | own product (changed by Archie, 2026-11-18) |
| I218 | Snagging report for new-build buyers | own product |
| I219 | Empty commercial unit report for expanding retailers | facilities and property |
| I220 | Company-owned property portfolio lookup | data and analytics |

**Traditional industries** (market industry: this category)

| ID | Idea | Function (estimate) |
|---|---|---|
| I141 | Trades: instant quote and booking assistant | sales |
| I142 | Trades: missed-call text-back and follow-up | sales |
| I143 | Haulage: operator licence and compliance reminders | legal, risk and compliance |
| I144 | Manufacturing: quote response drafts from spec sheets | sales |
| I145 | Manufacturing: capability page and supplier directory listings | marketing |
| I146 | Farming: grant and subsidy eligibility alerts | finance |
| I147 | Funeral directors: price transparency page | legal, risk and compliance |
| I148 | Garages: MOT and service reminder automation | customer service and success |
| I149 | Waste firms: licence checks and duty-of-care paperwork | legal, risk and compliance |
| I150 | Printers: instant online quote calculator | sales |
| I151 | Wholesalers: trade catalogue to online order form | sales |
| I152 | Dry cleaners: pickup booking page | sales |
| I153 | Private hire: corporate account quoting page | sales |
| I154 | Removal firms: volume estimator and quote | sales |
| I155 | Skip hire: postcode pricing and booking | sales |
| I156 | Engineering firms: tender finder and first-draft bids | sales |
| I157 | Garment makers: sample request and minimum-order quoting | sales |
| I158 | Builders' merchants: stock list feed for AI agents | sales |
| I159 | Scaffolders: handover certificates and inspection log | legal, risk and compliance |
| I160 | Locksmiths and glaziers: emergency pages by postcode | marketing |

**x402 data APIs**

| ID | Idea | Function (estimate) |
|---|---|---|
| I001 | UK company verification check (already built) | own product |
| I002 | Director network lookup: every company a person runs | own product |
| I003 | Company insolvency risk score | own product |
| I004 | Charges and lender lookup per company | own product |
| I005 | VAT number validation with trading-name match | own product |
| I006 | Local business density by postcode | own product |
| I007 | Food hygiene rating lookup by business | own product |
| I008 | Care provider (CQC) rating lookup | own product |
| I009 | FCA authorisation check for a firm or person | own product |
| I010 | Public tender matches for a given company | own product |
| I011 | Planning application lookup by postcode | own product |
| I012 | Energy certificate (EPC) lookup for commercial property | own product |
| I013 | Trademark conflict check against the UK register | own product |
| I014 | Domain age and website technology lookup | own product |
| I015 | Website agent-readiness score (llms.txt, structured data) | own product |
| I016 | Sanctions list screening (UK OFSI list) | own product |
| I017 | Gazette notice search by company | own product |
| I018 | Charity trustee and finance lookup | own product |
| I019 | UK bank-holiday and business-hours resolver for scheduling agents | own product |
| I020 | Verified supplier shortlist by trade and postcode | own product |

**x402 utility tools**

| ID | Idea | Function (estimate) |
|---|---|---|
| I021 | Web page to clean text extraction | own product |
| I022 | Filed company accounts to structured data | own product |
| I023 | Invoice data extraction per document | own product |
| I024 | Address cleaning and UK postcode validation | own product |
| I025 | Email deliverability and domain health check | own product |
| I026 | Screenshot and visual change detection for a URL | own product |
| I027 | Token and smart-contract safety assessment | own product |
| I028 | Search re-ranking tuned for UK business queries | own product |
| I029 | Document translation with a legal glossary | own product |
| I030 | Receipt scan to bookkeeping line | own product |
| I031 | Business utility price comparison | own product |
| I032 | Payment router across our own paid services | own product |
| I033 | Product data formatter for AI shopping feeds | own product |
| I034 | Contract clause classifier | own product |
| I035 | Company name to official registry match | own product |
| I036 | Review sentiment summary for any business | own product |
| I037 | Hiring-signal feed per company from job ads | own product |
| I038 | Carbon estimate per company from filed accounts | own product |
| I039 | QR code and short link with scan analytics | own product |
| I040 | Paid-tool directory listing with health checks | own product |

### Inherited from the category (280 ideas, approved)

Sales operations and bids → sales; Leads sold to other firms → sales; SME websites → marketing; Customer service and complaints → customer service and success; Operations and field service → operations and delivery; Finance and accounts → finance; Compliance and deadlines → legal, risk and compliance; Legal and company secretarial → legal, risk and compliance; Health, safety, quality and environment → legal, risk and compliance; HR and people admin → HR; Purchasing and supply chain → procurement; Documents, data and IT admin → IT and security; One-off data reports → data and analytics; Facilities, fleet and assets → facilities and property.

## Not built yet (Phase 6, as you asked)

- the Ideas feed of cards;
- the Board (with function and market filters);
- Pass / Fail / Question buttons;
- re-raise blocking in the feed.

The data, history and fingerprint they need are already in place.
