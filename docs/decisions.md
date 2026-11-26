# Decision log

Newest first. Each entry: what we decided, why, and who approved it.

## 2026-11-16 — v2 plan approved (Archie)

Plan: `brain/build-reports/v2-plan.md`. Answers:

- **D1 Freeze:** lifted **for v2 Milestone A only**, in dry-run (it adds measurement and checkout, not
  lead-quality or copy tuning). Archie runs cutover Stages 1–5 in parallel. Milestone B stays frozen
  until real outcomes exist. Stop at the Milestone A report.
- **D2 Revenue paths** (status-and-vision numbering): 3 monitoring alerts, 4 human company report,
  5 Agent House lead gen, 6 M&A target briefs — build nothing new on them; built monitoring and human
  check stay. x402 (path 2) not frozen, not in v2 scope. Archie adds the status-and-vision doc to brain/.
- **D3 Runtime:** production on Workers (Cron Trigger, Queues, Workflows, Durable Objects); Node kept
  for local dev and the bulk Companies House import; a Durable Object holds the change feed, with
  polling as the fallback. `CLAUDE.md` updated.
- **D4 Holdout:** holdout drafts are blind in Review; lift measured on assignment (intent to treat);
  rejected holdout drafts reported separately.
- **D5:** v2 reports in `brain/build-reports/`; earlier reports stay in `docs/`.
- **D6:** customer sites on the placeholder `sites.ejtech.example`; live will be a subdomain of
  ejtech.co.uk that is never used for sending.
- **D7:** business-function taxonomy added to `brain/taxonomy.md` (16 functions, 3 tiers).

## 2026-11-10 — Last pre-cutover fixes, then feature freeze

- Leads in cooldown: the approve button is disabled and the card says "Contacted [date], cooldown until
  [date]" (or what's still pending), from the same cooldown check the runner uses.
- Blocked duplicates: one `contact_blocked` alert per day, updated in place ("N duplicates blocked
  today"); the same company and reason isn't counted twice in a day. Letters lists the items.
- Overview "Today" panel (`/api/today`): drafts waiting, letters awaiting batch approval (+ waiting for
  the next batch), open conflicts, open alerts, and 7-day revenue / cost / margin from task totals.
- **Feature freeze** (Archie, 2026-11-10): no more feature work until the real-drafts stage of the live
  cutover is done (Stage 5 in docs/live-cutover.md; Archie called it "step 3 (real drafts)"). Only fixes needed for the cutover itself.

## 2026-11-10 — Fixes from the screenshot review

- **Trading disclosures everywhere** (registered name, "Registered in England and Wales", company number,
  registered office) from `infra.json` → `sender.legal`, via one `tradingDisclosure()` line used by
  every email footer, the paid report, alert payloads, letters, demo pages and the small public pages.
  A test renders every outbound template (the letter by decoding its PDF text) and fails if any part
  is missing. The real number and office aren't known yet, so they're **placeholders**; real sends
  refuse to run while they are, and Letters says "Don't print yet".
- **Copy rules, checked in code** (`infra.json` → `outreach.copy_rules`): one factual observation per
  message; company name at most twice; "I noticed" at most once; never lead with director, officer or
  ownership changes (those facts are no longer offered to the writer at all); structure = the
  observation as the first sentence → at least one sentence on why it matters → an offer (demo, ideas,
  short call). "Why it matters" itself can't be judged in code: the prompt asks for it, the checker
  only enforces that a sentence sits between observation and offer. Writer prompts are now v2.
- **One contact per company per 90 days** (`outreach.contact_cooldown_days`), across email and letters
  and every module: blocked if emailed or sent a letter in the window, a letter is pending in any
  batch, or a draft is already in progress. Follow-ups in the same email thread are exempt. Checked at
  intake, at send and when a letter is prepared; a batch never holds two letters to one company.
  Blocks are listed on Letters (and as alerts).
- **Print and postage per letter** (placeholders £0.12 + £0.87) are added to the task's cost when you
  approve a batch, so margins are real. They're left out of the automatic daily spend caps
  (`caps.exclude_steps`): you approved them, and counting them would pause the queue after every
  normal weekly batch.
- **Demo homepage service cards come from the company's SIC division** (`sic-sectors.json`, 17 sectors
  + default). The copy describes what each section of *their* site would show; it never claims
  anything about the company.
- **Drift**: a source isn't judged until it has 3 complete runs; failed, still-running and partial runs
  (a resumed or limited Companies House pull, flagged on the run) are ignored; resuming a source also
  closes its drift alert, so Alerts and Paused sources always agree.
- **x402_discovery is read-only**: removed from `playbook_for_module`; the API refuses to approve its
  leads; the Leads tab says why. Leads show "Approve → email" or "Approve → letter" from the same routing
  rule the runner uses.
- **Dashboard**: shared stylesheet; nav wraps; tables become labelled cards under 600px; a Playwright
  test (`tests/mobile-layout.test.ts`, now in CI) checks every page at 390px and 1440px, seeded and
  empty, for zero sideways scroll, with a negative control. Review has tabs and 20 per page; field
  labels and readable lists; empty states; Controls has one "Sending" banner and each playbook's own
  switch.

## 2026-11-09 — sme_letter: demo banner, expiry, letter opt-out

- **Demo banner** (fixed to the top of the screen): "Sample prepared by EJTECH Ltd, not affiliated with
  <registered company name>". The full registered name is used so there's no doubt which company.
- **No third-party logos or imagery**: the template has none, a test fails if any image, SVG, CSS
  `url()` or outside link appears, and the page is served with a Content-Security-Policy that blocks
  every outside resource (`default-src 'none'`), so it stays that way even if the template changes.
- **Demo pages expire 30 days after their batch is approved** (`letters.demo_expiry_days`): the page
  then answers 410 "This sample has expired." The letter's QR caption says how long the demo stays up.
- **One-line opt-out on every letter**: "Don't want letters from me? Email <from address> quoting
  <code>, or visit <demo host>/stop/<code>". The code is "L" + 6 unambiguous characters, unique per
  letter. The short URL shows a confirm button and records the opt-out on POST, so link previews can't
  opt anyone out by accident (alternative: one-click GET). An email quoting the code (any wording) is
  picked up by inbox processing. Both add `entity:<company number>` to the shared suppression list (the
  email route also adds the sender's address). Opting out works even while the kill switch is on.
- The line's wording lives in `infra.json` → `sender.letter_opt_out_text`; config refuses it if it
  drops the email, the code or the URL.

## 2026-11-09 — Changes before cutover (Archie's three changes)

- **x402 now uses the official flow**: `@x402/hono` `paymentMiddleware` + `x402ResourceServer` +
  `ExactEvmScheme` (all 2.30.0), replacing our own gate. Verify → our handler → settle only if the
  handler answered < 400 is the library's behaviour, so a failed premium re-check is still never
  charged. Our code keeps: the pre-check (bad number 400, unknown company 404 and free), logging and the
  ledger (on the way out), the kill-switch guard around the facilitator, and the fake facilitator.
- **The fake facilitator now checks what a real one does for EIP-3009**: signature (fake), recipient,
  amount, network/asset, validity window (`validAfter` ≤ now < `validBefore`, no longer than
  `maxTimeoutSeconds`) and nonce replay. Tests cover each.
- **EIP-712 domain is now explicit config** (`products.json` → `x402.eip712`), and a test checks it
  against the library's USDC table. Reason: Base Sepolia USDC is named "USDC" but Base mainnet USDC is
  "USD Coin"; a mainnet switch that changed only network and asset would produce signatures the
  facilitator rejects.
- **On Cloudflare the middleware is built per request** with the facilitator's `/supported` answer
  cached as a value. Reason: the library syncs with the facilitator once and shares that promise across
  requests, which Workers don't allow (the request hung; found by the Worker bundle test). Alternative:
  `syncFacilitatorOnStart: false` plus our own sync (more custom code). Also: the Worker now needs
  `nodejs_compat` (the middleware uses `Buffer`).
- **Site-level website facts hold for 90 days, then go stale** (`hold_until_expiry` in the field
  registry): website found, URL, copyright year, last modified, HTTPS, mobile-ready, contact email. Before,
  a 45-day half-life pulled a single website source (0.75) below the 0.7 floor within about 5 days. The
  floor and crawl frequency are unchanged, as asked. There's no separate "tech stack" field: HTTPS and
  mobile-ready are the tech facts we collect. Job postings keep their 30-day decay.
- **`sme_letter` (L0)** for approved leads with no emailable address (no verified contact email, or a
  company type that needs prior consent). Routing is config (`infra.json` → `letters.fallback_for`).
  Truth check identical to email. The demo homepage is a deterministic template using only verified
  facts (name, town, trading since), not model-written: no invented services, reviews or phone numbers.
  Alternative: model-written sector copy (needs its own checker). Letter: A4, "The Directors" in the
  envelope window position, QR drawn as vector squares (prints sharply), sender identity and opt-out
  added by code.
- **Print batches**: letters wait at a gate; once every 7 days the waiting letters become one batch;
  approving it decides every letter's gate (you can leave some out). Demo pages are served only for
  approved letters **and** only while external actions are allowed for `sme_letter`, so the kill switch
  also takes every demo offline. Alternative: publish demos at prepare time (rejected: nothing public
  before you approve).
- **Letter opt-outs use the shared suppression list** (`entity:<company number>`; API
  `POST /api/letters/opt-out/:company`). Suppressed companies get no letter task.
- **Accountant-address bias is flagged, not blocked**: care-of, accountancy/formation wording, or ≥ 5
  companies sharing the registered office. You decide per letter.
- **Claude adapter**: server-side refusal `fallbacks` are sent only to models that support them (Opus
  5.5, Sonnet 5.5). Haiku 5.5 has none, so without this the Haiku extraction comparison would have
  failed on its first call.
- **Cutover order is now time to cash** (`docs/live-cutover.md`), with the Haiku 5.5 (extraction) and
  Sonnet 5.5 (drafting) comparisons as a config switch in `models.json`. Phone outreach stays out of
  scope; if added it must screen against CTPS/TPS first.

## 2026-11-08 — Phase 5 decisions (review at the end)

- **⚠ Prices (yours to set): monitoring £19/month per customer (+ £0.50 cost budget per alert), human
  company check £9** (`products.json`).
- **⚠ Monitoring is a one-month Stripe Checkout payment in v1, and watches don't expire yet.** Real
  recurring billing should use Stripe Subscriptions (`mode=subscription`, then `invoice.paid` /
  `customer.subscription.deleted` to keep or switch off watches). Not built on guessed event shapes —
  it's on the live-cutover list. Alternative: build it now against the documented API.
- **Outreach starts at L1** (each email approved by you, then sent). `human_report`, `watch_alert` and
  `monitoring_subscription` run at **L3** (automatic) because they deliver something a customer has
  already paid for; they still obey the kill switch, spend caps and lanes.
- **Autonomy is earned, never automatic**: the Controls page shows each playbook's last 50 tasks
  (≥ 20 needed; success ≥ 90%, approved without edits ≥ 80%, zero breaches) and only *suggests*
  promotion; you click it. Any guardrail breach demotes the playbook one level immediately.
- **Who we email**: only a role-based address (info@, hello@, enquiries@, contact@, sales@, office@)
  found on the company's own website, on the company's own domain, for limited companies / LLPs /
  PLCs only (sole traders and partnerships need prior consent → blocked). The contact address is used
  at any verified confidence (it's routing, not a claim); statements in the email still need ≥ 0.5.
  Alternative: require ≥ 0.5 for the address too (fewer, safer sends).
- **Follow-ups**: up to two follow-ups, 5 days apart, if there's no reply (max 3 emails per company
  without a reply, 1 recipient per send), each needing its own approval at L1. Any reply stops follow-ups; an opt-out reply ("no thanks", "remove me", …) adds the address
  *and* its domain to the global suppression list.
- **The paid report email is transactional** (the customer asked for it), so outreach rules
  (suppression, company-type) don't apply to it; the kill switch still does.
- **Stripe webhooks are idempotent on the event id and the Checkout Session id** (Stripe retries).
- **No card checkout while delivery is switched off**: on Cloudflare, checkout returns 503
  `service_paused` while the kill switch is on for that product, so nobody pays for something we
  can't deliver. Locally (fake Stripe) checkout always works.
- **Playbooks are bundled into the Worker** (`pnpm gen:playbooks` → `playbooks.generated.ts`, a test
  fails if it's stale) because Workers can't read files.
- **Phase 5 gate picks reachable leads**: the top-scoring leads are often companies with *no*
  website (the strongest need), which correctly can't be emailed. The gate approves the top leads
  with a verified contact address plus one without, to show the "no recipient" block. For live use
  this means: **no-website leads need another channel (phone/post) — consider a separate playbook.**

## 2026-11-08 — Phase 4 decisions (review at the end)

- **⚠ Launch prices (yours to set): $0.05 cached, $0.25 premium** in USDC (`products.json`). Picked as
  low enough for agents to call freely and well above our marginal cost (~£0.0002 / ~£0.001 per call).
- **Our own small x402 v2 payment gate** over a facilitator port (shapes from `@x402/core` 2.30 types;
  headers PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE), instead of `@x402/hono`'s
  middleware. Reason: we verify → do the work → settle only on success (a failed premium re-check or
  missing data is never charged), plus our own logging and kill-switch guard. The real facilitator is
  the official `HTTPFacilitatorClient`. Alternative: the library middleware (re-evaluate at cutover).
- **Testnet first**: Base Sepolia (`eip155:84532`) with its USDC contract; mainnet (`eip155:8453`) is a
  config change after the testnet gate.
- **The live Worker only enables x402 with a REAL facilitator** (env `X402_FACILITATOR_URL` +
  `X402_PAY_TO`), and refuses payments while the kill switch is on. The fake facilitator (which accepts
  a known fake signature) is localhost-only.
- **x402 is public; the dashboard is behind Access.** Cloudflare Access on workers.dev covers the whole
  hostname, so the paid endpoint must be served on its own hostname without Access (suggest
  `check.oast-ai.com` → same Worker, route `/x402/*` only).
- **Unknown companies are free** (404 before any payment challenge).
- **Premium = live re-check from Companies House before answering**; if it fails → 503, not charged.
- **x402 request log → fact** `x402_checks_30d` (source `x402_requests`, our own log) → signal
  `x402_interest` → module `x402_discovery` (approved leads go to `sme_outreach`, pilot rules apply).
- **Blind verifier**: deterministic daily sample (hash of company/field/day), base 2%, adapting per
  source+field (more disagreement → up to 50%; none → down to 1%); re-derives from Companies House with
  only the company number and field name; disagreements → re-verification request + alert.
- **Streaming API consumer runs in the Node agent runner** (long-lived connection; Workers can't hold
  one). Events for companies in our anchor registry → re-verification requests; timepoint saved and
  resumed.

## 2026-11-08 — Phase 3 decisions (review at the end)

- **Modules start in "pilot", go "live" only with a backtest of the current note version at ≥ 3× lift.**
  Lift needs outcomes and outcomes need outreach, so pilot allows up to 50 approved leads a week
  (`infra.json` → `modules.pilot_weekly_limit`). Promotion is `promoteModule` (refuses below 3×).
  Alternative: block all outreach until a backtest exists (impossible without outcomes).
- **Your verification settles a fact.** A "human" claim's cluster always wins and the fact is verified
  (not a conflict); other sources become conflicting evidence. Resolving a conflict adds the company to
  the golden set (reason "conflict").
- **Calibration** is measured on the fact we'd have served without your claim, in confidence bands, plus
  a Brier score. Accuracy is per source+field: each source's latest claim vs your value.
- **Drift** compares each day's fetches per source+field with a 7-day baseline (volume ×0.5/×3, empty
  values +20 points, match rate −10 points, average ±50%; all config). A breach pauses that
  source+field: its facts become `quarantined` until you resume it (dashboard → Metrics).
- **Weight suggestions** need ≥ 20 closed leads and ≥ 5 positives; they're revenue-weighted (deal value)
  and blended 50/50 with the current weights (shrinkage), rounded to sum to 1. Written into the note as a
  PENDING block; only `pnpm weights accept <id>` changes the front matter (and bumps the version).
- **Nightly re-verification** priority = value (explicit request 3 > live lead 2 > other 1) × staleness ×
  uncertainty, within 2,000 API calls a night (config).
- **Backtests use today's universe membership** (known bias: companies that left the universe since
  as_of are missing) — logged in known biases.
- **Synthetic gate copies**: the Phase 3 gate writes its suggested change to a copy of the note in
  `docs/gates/phase3-outputs/`, never to `brain/frameworks/`.

## 2026-11-08 — Phase 2 decisions (review at the end)

- **⚠ Confidence floor 0.7 vs single-source website facts.** A tier-3 website fact starts at 0.75 and
  decays below 0.7 within ~5 days of fetching; tier-1 officer facts (half-life 15 days) fall below 0.7
  after ~7 days. With the 0.7 floor in `lead_gen_sme_web`, signals go neutral unless the module runs
  right after a refresh. **Kept your 0.7**; modules run on the day of the data refresh. Alternatives:
  lower the floor to 0.5, or per-signal floors (`min_input_confidence` already exists on signals).
- **Every model role uses `claude-opus-5-5`** (the Claude API guidance's default; it forbids silently
  downgrading for cost). Effort per role is set in `models.json` (low for extraction/research/
  explanations, medium for writing, high for checking). Alternative to consider at cutover: Haiku 5.5
  or Sonnet 5.5 for bulk website extraction (~40× / 2× cheaper) — your call.
- **Server-side refusal fallbacks on** (`fallbacks: "default"`) in the real Claude adapter, as the
  guidance recommends. Turn off in `packages/ports/src/anthropic.ts` if you prefer.
- **Playbook steps are orchestrated in code, with one model call per role step** (Claude Messages API
  behind `ModelClient`), rather than giving each role an autonomous Claude Agent SDK loop. The tool
  registry, checks and costs stay fully under our control and testable. The Agent SDK is reserved for
  roles that genuinely need open-ended tool use (none at L0). Alternative: Agent SDK `query()` per role.
- **The truth checker is deterministic code**, not a model: claims must cite brief facts, contain the
  fact's key value, appear in the body, and no unsupported number/date may appear. Sender identity and
  opt-out are added by code, never the model. Alternative: an extra model-based checker (can be added).
- **Expected value v1**: P(win) = base_win_rate × score ÷ 0.5 (capped), × deal value, both in the
  framework note (2%, £1,500 placeholders). Phase 3 calibrates from outcomes.
- **Unknown signals score neutral (0.5)** for every signal, not just staff size (your staff_unknown rule
  generalised). "No website found" scores as the oldest possible website.
- **Website anchoring**: a site's facts attach only if it shows this company's number, or its title
  matches the name (≥ 0.6 similarity), or its trading postcode matches; a site showing another
  company's number goes to quarantine.
- **The dashboard API records decisions; the agent runner applies them** (Workers can't run
  playbooks). Locally both run in one process, so decisions apply immediately.
- **Approved leads map to playbooks in config** (`infra.json` → `playbook_for_module`).

## 2026-11-08 — Keyless build of Phases 2–5 (Archie's change of plan)

- **Build Phases 2–5 without stopping at gates**; each phase still ends with a synthetic gate report.
  Every external system sits behind an interface ("port") with a fake; real adapters plug in at
  cutover (`docs/live-cutover.md`). The global kill switch defaults to ON (external actions off).
- **Period-dated facts don't decay** (Archie's change). Headcount, accounts category and accounts
  made-up date describe a fixed accounting period: confidence stays at the source's reliability, and
  the fact goes `stale` after its shelf life (640 days from the period end), when a newer period's
  figure is due. Alternative considered: decay from period end (made headcount confidence 0.3–0.6).
  *Interpretation note:* the full wording of this request wasn't visible in the session; this is how
  it was implemented, from the one-line summary.
- **Header-driven rate limiter** (Archie's change). Each response's `X-Ratelimit-Remain` /
  `X-Ratelimit-Reset` drive the pacing: when the remaining quota reaches the reserve (15% of the
  limit) we pause until the reset; a 429 pauses until the reset (not exponential backoff) and doesn't
  use up retries (capped at 20 pauses per request). The token bucket stays as a ceiling if headers are
  missing. Alternative: token bucket only (ignores the server's own view of the quota).
- **Companies House Streaming API in Phase 4** (Archie's change): see `docs/PLAN-phases-2-5.md`.

## 2026-11-07 — Phase 1 build decisions (for Archie's review at the gate)

- **Point-in-time answers are rebuilt from claims**, not looked up from stored fact versions. Each
  claim keeps when it was published and when we fetched it, so "what was known on date X" (and its
  confidence then) is recomputed exactly; rolled-back runs drop out automatically. Stored fact
  versions remain the audit trail of what we recorded, and when.
- **`observed_at` = when the source said it was true** (original brief); `published_at` = when it was
  knowable (Archie's rule). Facts carry `valid_from` (earliest published) and `first_observed_at`
  (renamed from `effective_from`, which mixed the two).
- **Registers keep asserting their current state.** Companies House is "continuous": a value stays
  fresh until superseded or until our last fetch, so a historical state wasn't "decaying" at the time.
- **Copies of one upstream count once and the freshest copy wins** (CH API vs CH bulk file), so a
  month-old bulk value never "conflicts" with today's API value.
- **Deterministic claim IDs**: the same source saying the same thing at the same published time gets the
  same ID; a re-fetch records an observation, not a duplicate. Ingestion is idempotent.
- **History as snapshots** (officers, PSC, charges: 6 years; filings: 3 years) — one claim per
  publication date, so backtests can see past states. Window sizes are config.
- **When a publication date can't be proved, use the fetch time** (conservative; counted per field).
- **Headcount shelf life 640 days, half-life 365 days**, measured from the accounts period end. The
  next figure arrives up to ~21 months after a period ends, so 400 days marked current figures stale.
  Consequence: headcount confidence is honest but low (≈ 0.3–0.6). Phase 2's size signal should use its
  own `min_input_confidence`; calibrate in Phase 3.
- **Conflict margin 0.15**: a disagreement is a `conflict` (review queue) unless the winning cluster's
  independent reliability beats the next by at least 0.15. Config: `verification.json`.
- **Unknown-staff companies scored neutral** is recorded in config (`unknown_policy: include_flagged`);
  the neutral scoring itself is Phase 2's signal code.
- **Phase 1 runs on synthetic data until the key is added.** A seeded generator produces bulk, ONS and
  accounts files plus fake API responses with a known right answer (`pnpm rehearse`).

## 2026-11-07 — Phase 0 build decisions

- **Worker compatibility date pinned to 2026-08-01** (not "today"). The local Cloudflare runtime used
  in tests supports dates up to August 2026; pinning means tests and production run identical
  runtime behaviour. Bump deliberately, with a test run, when needed.
- **Markdown is not touched by the formatter (Biome).** `brain/` notes are edited in Obsidian; a
  linter rewriting them would create noise and could disturb front matter.
- **SIC exclusion rule:** a company is excluded only if *all* of its SIC codes are on the exclusion
  list. A trading company that also lists a holding-company code (64209) stays in.
- **Access is checked twice:** at Cloudflare's edge (one-click Access on the workers.dev URL) and
  inside the Worker (JWT validation, fails closed if not configured). Preview/version URLs are
  disabled until Access covers them too.
- **Claims are append-only at the database level** (triggers refuse UPDATE/DELETE), not just by
  convention.
- **`effective_from` added to verified facts** alongside `valid_from`: `valid_from` = earliest
  supporting `published_at` (when knowable, used for point-in-time), `effective_from` = earliest
  `observed_at` (when it became true).

## 2026-11-07 — Phase 0–1 plan approved by Archie

- Biome, TypeScript 5.9, plain SQL migrations (no ORM), Cloudflare Containers for the agent runner,
  Companies House bulk file + ONS postcode lookup for the universe, accounts data (iXBRL) for staff
  numbers.
- Universe: active, non-dormant, 10 Greater Manchester boroughs, 5–100 staff. Exclude SIC 64209,
  68209, 74990, 99999. Keep 68310, 68320. Exclusions live in config.
- Unknown staff numbers: included, flagged `staff_unknown`, neutral on the size signal.
- Size signal: staff band where known, `accounts_category` as fallback.
- PSC (ownership) pulled in Phase 1.
- Registered office used for location in Phase 1 (logged as a known bias).
- Point-in-time: mode (a) "reconstructed" by default, using `published_at` (filing received /
  published) as the knowable date; mode (b) "strict" also available; every backtest states its mode.
- Deploy an empty health-check API behind Cloudflare Access at the end of Phase 0.

## 2026-11-16 — v2 Phase 1 build decisions

- **A company-level opt-out covers every channel.** "No more letters" (by post, email or the short URL)
  now also stops email at intake. Why: one global suppression list; the v2 gate caught a holdout email to
  a company that had opted out of letters.
- **Accountant / formation-agent registered offices are skipped at intake** (config
  `measurement.skip_flagged_registered_offices`, on), not only flagged in the print batch. Why: we hold
  no trading address, so the letter rarely reaches the directors; the plan audit listed this as missing.
- **Holdout gets the same compliance checks but not the EV gate**, or it wouldn't be random (D4).
- **Blind review hides the task reference, idempotency key and arm** while a draft awaits approval.
- **Letter "sent" is recorded when the print batch is approved**, flagged dry run while the sme_letter
  kill switch is on.
- **Review time** = visible dashboard time since the previous decision, charged to the next decision;
  a print batch's time is split across its letters.
- **P(paid) is one estimate per playbook** (Beta-binomial on priors) until real outcomes support more.

## 2026-11-16 — v2 Phase 2 build decisions

- **One job handler for Workers and Node** (`handleJob`); the local queue copies Cloudflare's retry and
  dead-letter rules (3 retries, then dead letter + alert).
- **External actions are recorded before they run** (`external_effects`). A retry replays the recorded
  result; an action with an unknown outcome is refused until a person marks it happened / didn't.
- **Live vs dry-run workflows**: an instance is live if external actions were allowed when it started.
  Live instances check the kill switch before every step and wait while it's on, so a paid fulfilment
  never silently turns into a simulation. Dry-run instances can't act externally, so they continue.
- **Trigger rules are config**; only the `explain` action may call the model (enforced by the config
  schema). Every event given is processed; batch size is applied when putting events on the queue.
- **Change feed source = the existing `HttpChangeStream` client** (built in an earlier phase, flagged to
  verify at cutover), wired via `streamFeedSource` when `CH_STREAM_KEY` is set. The docs couldn't be
  re-checked from this build environment (blocked); polling is the fallback meanwhile.
- **The Worker uses the fake model unless `MODEL_LIVE=1` and the `ANTHROPIC_API_KEY` secret are both
  set** (cutover switch; models unchanged).

## 2026-11-16 — v2 Phase 3 build decisions

- **Reserve → settle budgets in one Durable Object** (SQLite-backed, synchronous KV): all-or-nothing
  across task, playbook-day, global-day and explore-week scopes. Seeds from the run log so caps survive
  a fresh object. The after-the-fact cap check stays as a second line of defence.
- **Each step holds min(`step_reservation_gbp`, task budget left)**: holding a flat amount would block
  playbooks whose whole task budget is pennies.
- **Spend tiers S0–S3**: S0 = the existing per-playbook cap; raising needs a single-use owner approval
  created only by the dashboard (Access identity recorded); lowering is free.
- **L3 autonomy needs an owner approval** (rule 14).
- **Explore share** = 10% of the weekly budget (global daily cap × 7) for experiment / explore tasks.

## 2026-11-16 — v2 Phase 4 build decisions

- **Claim = setup fee + monthly subscription**, B2B only (the company on the sample page); prices and
  terms are placeholders in `products.json` pending Archie and legal review.
- **Fulfilment is a workflow** with two human waits (customer details, Archie's publish approval) using
  `waitForEvent`; the anchor task (`claim_site`) is owned by the workflow, not the queue.
- **Cancellation/refund stops fulfilment at the next step** (checked before every step; waiting steps are
  woken with a cancelled event); the site comes down.
- **Attribution**: claim payments and renewals are attributed to the outreach task behind the sample page.
- **Stripe subscription call deferred**: docs unreachable; the real call refuses to run; event mapping
  is isolated in `toSubscriptionEvent` and marked unverified.
- **Tools that refuse before acting throw ToolBlockedError** → effect recorded as "didn't happen".
- **post_reply at L0**: triage in code; the reply is untrusted input to the writer; complaints get no
  sales follow-up.

## 2026-11-17 — v3 plan approved (Archie)

- **Milestone C** (Phases 1–5) approved; build without stopping, stop at `brain/build-reports/v3-milestone-c.md`. Milestone D waits.
- **D1 Mail**: replies via Cloudflare Email Routing to a dedicated address on the sending domain (never Archie's inbox). Sending provider chosen later; when shortlisting, check its terms allow B2B cold outreach.
- **D2** `OWNER_HOURLY_GBP` = £40 placeholder, labelled an assumption.
- **D3** Pass on an idea: queued; a test auto-starts only if budget ≤ `AUTO_START_TEST_GBP`, inside the weekly explore share, within the playbook's spend tier, and the card has kill criteria and a sample size. Otherwise a budget decision.
- **D4** Keys in Cloudflare Secrets Store, written through a narrow edit-only token; values never in D1, `brain/`, logs or any agent.
- **D5** Build-request cards now. If Claude Code ever runs from GitHub: only from Archie's label or comment (never a schedule), narrow permissions, CODEOWNERS + branch protection on safety-layer files, code changes never auto-merge. CODEOWNERS and branch protection go on the manual settings list.
- **D6** Mailbox tools (list, read, draft; no send) through the tool registry; an MCP endpoint wraps them, marked unverified.
- **Page mapping** approved: verification golden set → CRM "Verify" tab. The *playbook* golden set (Milestone D, captured from Archie's decisions) belongs with the Needs-you queue.
- **Ideas sheet** `brain/ideas/seed-500.csv` (Archie adds it): shown in the Vault (Phase 4); the starting hypothesis backlog and Board tiles in Phase 6. Every score in it is an estimate, labelled assumed, never an outcome, never used to train scoring.
- **`/thanks`** (frozen human-report checkout) stays flagged and unchanged.

## 2026-11-17 — v3 Phases 4–5 build decisions

- **Vault edits are versions in D1** (`note_versions`). `brain/` in git is the base, bundled into the
  Worker at deploy. An edit made on the page shows "edited here, not yet in git" until it's committed. Agent
  notes are refused without provenance (author, time, and at least one source or ledger row).
- **Keys (rule 20)**:
  - A tool declares the keys it needs (`ToolRegistration.keys`). The registry injects them on **live
    calls only**, and scrubs every injected value from results, errors and the call log.
  - Only `packages/infra/src/keys.ts` calls `KeyStore.reveal` (static test).
  - `key_registry` holds status only, with no value column.
- **Token permission name**: Cloudflare's docs call it "Account Secrets Store Edit" (some snippets say
  "Secrets Store Write"). The plan said "Edit"; both names refer to the same permission.
- **Secrets Store list call unverified**: create (POST) and replace (PATCH) follow the docs; the list call
  that finds a secret's ID is marked unverified.
- **Model key**: `@anthropic-ai/sdk` 1.6.0 sends the key in the `authorization` header. The leak test checks
  it's in a header and never the body.
- **A refused key** (401/403) → status failing, one `key_failing` decision (safe default: keep paused).
  Only the dependants listed in `keys.json` pause; their tasks wait untouched and take no queue slot.
  Saving a new value resumes them and supersedes the decision.
- **The Worker rebuilds its app at most once a minute**, so a newly saved Stripe or Companies House key
  takes effect without a deploy.

## 2026-11-17 — Seeded ideas (`brain/ideas/seed-500.csv`)

- Archie's 500-row sheet is committed unchanged and imported as **hypotheses** (migration 0018). The
  import is idempotent on `id` and rejects the whole file on any invalid row, naming the rows.
- **Score and matrix are recomputed in code.** Score = Σ(weight% × score) / 5 (exact for these weights);
  matrix = value (mean of demand and margin) × feasibility (mean of the other four), with 4+ counting as
  high. All 500 rows agree with the file.
- **Every seeded score is an estimate (rule 23).** The `score_source` column only accepts `estimate`. Score
  changes keep a who/when/why history. Static tests keep scoring, learning, ledger and verification code,
  and all other SQL, away from the hypotheses tables.
- **A re-import** keeps Archie's decision and comments, and any stage changed by Archie or an agent. Text
  and scores follow the sheet (open question to Archie: should dashboard score edits survive a re-import?).
- **Categories → taxonomy** in `packages/config/src/idea-categories.json`: 14 mapped and 11 left unmapped
  (industries, channels or product types), listed for Archie rather than guessed.
- **Ideas feed, Board and Pass/Fail/Question** are Phase 6 (Milestone D, on hold). Idea decisions will be
  applied through `decide()`; no route sets them now.
- **Milestone D on hold.** Archie runs cutover Stages 1, 1b, 1c and 1d, then saves the Companies House and
  Anthropic keys. On Archie's word, run Stage 5 (20 real drafts) for review before Phase 6.

## 2026-11-18 — Seeded ideas: Archie's answers

- **Score edits stick.** After the first import the dashboard is the record. A re-import adds new ideas
  and updates text. It updates a score only if nobody changed it since import, so a score changed by Archie
  or an agent is kept (detected from the score history). Both values stay in the history.
- **Function and market on every idea** (migration 0019):
  - **Function** is a `brain/taxonomy.md` node, or "own product". The 14 mapped categories pass their
    node down, and Archie approved the three judgement calls. The 220 ideas in the 11 unmapped categories
    carry a per-idea function assigned from the idea text (`packages/config/src/idea-functions.json`).
    These are labelled estimate and listed in `brain/build-reports/v3-seed-ideas.md` for spot-checking.
    A function someone sets later survives re-imports.
  - **Market** is the buyer, plus the industry for the five industry categories.
  - The Vault filters by both now; idea cards and the Board will in Phase 6.
- **Spot-check (2026-11-18):** Archie changed I217 (building rules guide) and I239 (council open-data
  dashboards) to "own product" and kept the other 218 as assigned. On re-import, exactly those 2 ideas
  changed and the other 498 stayed as they were.

## 2026-11-18 — Task graph layer approved (Archie); G0 built

- Plan: `brain/build-reports/graph-plan.md`.
- **A:** convert all seven playbooks to graphs in G1, with equivalence tests; frozen ones stay frozen.
- **B:** order is G0/G1 (with Stage 5 in parallel), then G2/G3, then Phase 6, then G4/G5.
- **C:** gate reports go in `brain/build-reports/`, with evidence in `docs/gates/`.
- **Addition 1:** Archie's reject reasons go in a separate decision log (`decision_log`), which the planner
  reads when revising and in its eval. They never enter the outcome ledger.
- **Addition 2:** the price table was checked against the live pricing page on 2026-11-18; cache prices
  and Haiku's long-prompt tier were added; `price_table_version` is stamped on every cost event.
- Graph down-migrations live in `packages/storage/migrations-down/`, because Wrangler applies every `.sql`
  file in the folder it deploys.
- **Stage 5 runs on Archie's deployment.** By rule 20, no agent can read the Anthropic key, and the real
  data lives in D1. The build session provides the review summary.

## 2026-11-18 — Task graph G1

- **Compiler:** 16 rules, pure and deterministic, with structured errors and a failing fixture for every
  rule. **Interpreter:** one runtime, deterministic order, declared keys only, bounded loops.
- **Playbooks as graphs:** six are converted mechanically and proven equivalent to the old runner on eight
  scenarios. `claim_site` is converted by hand from its workflow and rejected by rules 11 and 8 (see the
  G1 report). It stays on its workflow pending Archie's decision.
- **Rule 11:** read as "an approval on every path into a send, with only deterministic checks between
  them".
- **Rule 8:** Archie's approval doesn't replace the checker for model-written text; Archie's own edits
  count as checked.
- **`sme_outreach` research** is narrowed to `verified_facts` in its graph (the code never calls
  `web_fetch`). Its SKILL.md is unchanged.
- **Found:** the old runner restarts a gateless playbook (`human_report`) from step 0 after a
  twice-failed check is approved. Not changed (frozen path); reported to Archie.

## 2026-11-18 — Task graph G2

- **`GraphRunWorkflow`** runs graphs on Cloudflare Workflows. It sits behind the `GRAPH_ENGINE_ENABLED`
  var, which is off by default, and only `sme_outreach` is switched. Role nodes run as `graph_node` jobs
  on the `JOBS` queue (with its dead-letter queue) and report back with `gd-…` events.
- **Pauses before every node:** queue pause, the playbook's kill switch, the graph budget, and the pool.
  The pool is enforced only with a real model. The global kill switch keeps its meaning: tools run dry.
- **An unanswered approval** defaults after 7 days: nothing is sent, and it's recorded as "defaulted".
- **State values are capped at 512 KiB.** Checked against Cloudflare docs on 2026-11-18: a D1 row holds
  2,000,000 bytes, and a Workflow step result holds 1 MiB.
- **The G0 "no runtime change" criterion** is restated as "no runtime change by default".
- **The old runner stays** until the flag has been on in production. Removing it now would break a
  deployment with the flag off.

## 2026-11-18 — Task graph G3

- **Sandbox mode:** fakes only (a real model is allowed, for real costs); every external tool dry and
  keyless whatever the switches say; tasks synthetic; spend recorded as `mode: "sandbox"`, never live;
  £2 per attempt and £5 per graph (probes included), from `graph-policy.json`.
- **Scenarios** come from what the happy path did: "Archie rejects" where it asks for approval, "tool
  error" on the first tool it called, and "kill switch on" for every playbook.
- **A failed role node** (a thrown tool or model error, or no report back) ends the run and the task as
  `failed` with the reason, and raises a `graph_failed` alert. Before, the run was left at "running".
- **Probes:** at most 5 nodes, read-only, with no operator, approval, wait or external tool, including
  tools a role's step lists. They run with the planner (G4).

## 2026-11-19 — v3 Phase 6 (Ideas feed, Board, research agents)

- **Signals** are strict: a value is a number, a boolean or a short lowercase code; the buyer comes from
  the closed `buyers` list; the industry must be a sector key. A sentence can't ride in a signal, so
  nothing a scout read can reach the planner as text.
- **Card economics** are computed in code. A derived figure takes the weakest label of its inputs and
  carries their assumptions. Review minutes per send are assumed at 1 until logged minutes exist.
- **A card without a seeded hypothesis is its own hypothesis record.** Its failed versions block an
  unchanged re-raise. Seeded hypotheses still get Fail plus a fingerprint.
- **Fail reasons** go to `decision_log` (subject "idea"), never the outcome ledger.
- **Pass** follows D3, plus a send-volume slot check: weekly sends ÷ the smallest sample in play.
- **Board pin and kill** are recorded through `requestAndDecide` (type "board"; safe default "unpin").
- **Post-mortems** are Vault agent notes at `brain/experiments/<id>.md`, labelled synthetic where they
  are. The Vault now accepts a "synthetic" provenance label.
- **New model role `planner`** (Opus 5.5, high effort), as with every other role.

## 2026-11-19 — Task graph G4 (planner)

- **The planner's budget cap is the suggested budget,** computed in code: 20% of expected value per
  task (P(paid) × first-year value), capped by the playbook's per-task limit.
- **Code sets each plan's identity:** graph id `plan-<card>`, version, task, opportunity and planner
  metadata. The planner's answer is `submit_graph` or `request_probe` and nothing else.
- **Every sandbox run gets a fresh database.** Probe reports are copied into the main database (mode
  "probe") for the approval card.
- **Planning and running approved plans sit behind `GRAPH_ENGINE_ENABLED`,** like all graph runs.
- **Planning runs in the Node tick** for now. A sandbox D1 database would let it run on Workers (a
  question for Archie).
- **Eval:** 20 synthetic cases in `evals/planner/cases.json`, with results per prompt version in
  `evals/planner/baseline.json`. A static test keeps planner code away from `evals/` (rule 13).
- **The graph view is our own SVG,** drawn from the compiler's layers; no graph library.

## 2026-11-19 — Task graph G5 (promotion)

- **Settling:** `promotion.settle_after_days` (14) after a run ends, its metric is read from the ledger
  (`count_replies`, `count_paid`, `draft_approved`). Only live-mode, non-synthetic, non-dry-run runs
  count. The gate's synthetic history uses a test-only switch, which no production file may use (a
  test checks this).
- **Promotion** needs ≥ 5 runs, 0 breaches and a Wilson lower bound of at least 0.6 (z 1.645). It's a
  `promotion` decision; approving writes `promoted_playbooks` at L1 and sets that name's autonomy
  control. A defaulted promotion decision never promotes.
- **A breach** drops the shape, and its promoted playbook, one level.
- **Graph runs inherit their task's synthetic flag.**
- **Subgraphs that can send are opaque to the compiler:** guardrails are re-required around them.

## 2026-11-24 — Dashboard on engine.ejtech.co.uk (Archie)

- **The Worker is served on the Custom Domain `engine.ejtech.co.uk`; `workers.dev` is off.** Archie put
  the whole ejtech.co.uk domain (`ejtech.co.uk` + `*.ejtech.co.uk`) behind one Access app that allows
  only his email. The `workers.dev` hostname sits outside that app, so it's switched off rather than
  left reachable. Supersedes "one-click Access on the workers.dev URL" (2026-11 entries above).
- **The in-Worker JWT check is unchanged:** `ACCESS_POLICY_AUD` is now the AUD of the domain-wide Access
  app. Until it and `ACCESS_TEAM_DOMAIN` are set, `/api` still fails closed.
- **The old `agent-house` Worker stays as it is.** Archie chose not to delete it.
- **Public routes** (`/x402/*`, webhooks, demo, opt-out, claim) are unreachable from outside while the
  domain-wide app covers them. When one goes live it gets its own hostname with an Access **Bypass** app
  (replaces the earlier `check.oast-ai.com` suggestion). Runbook: `docs/runbooks/deploy.md`.

## 2026-11-24 — Ranked idea matrix (Archie)

- **Archie's 41-idea matrix** (`brain/ideas/ranked-ideas.csv`, kept as they wrote it) goes into the backlog
  with **its own four scores**: fit, speed to £, demand, solo-build (1–5, max 20). They aren't forced
  into the six seeded scores, so nothing is invented (Archie's choice). Table `idea_matrix`, migration
  0024 (with its down file).
- **Score (the sum) and rank (competition ranking) are recomputed in code** and compared with the
  file; all 41 match. Ids are `R` + the sheet's List #, so re-imports update the same rows and never
  overwrite Archie's decisions or comments. Every score is labelled estimate (rule 23).
- **Importing:** locally with `pnpm ideas:import --sheet ranked`; on Cloudflare from Vault → Ideas sheet
  → Ranked ideas → Import.

## 2026-11-24 — First deploy prepared from the cloud session

- **D1 database `agent-engine` created in Western Europe (WEUR)**, nearest to Manchester, and all 24
  migrations applied. Its id is in `apps/api/wrangler.jsonc` (not secret).
- **Queues `ae-jobs` and `ae-jobs-dlq` created** by hand. `wrangler deploy` doesn't create queues;
  the earlier checklist line saying it did was wrong and is corrected.
- **The Worker publish moves to Archie's laptop** (`wrangler login`). In a cloud session the Cloudflare
  token is added to requests by the network proxy, which replaces the one-off ticket wrangler uses to
  upload the dashboard files (401 on `workers/assets/upload`). Everything else (API calls, D1) works
  with the proxy-injected token. The checklist is in `docs/runbooks/deploy.md`.

## 2026-11-26 — All spend on the cost ledger, written at call time (data layer plan, commit 0)

- **`cost_events` is now the one money truth.** Every agent-side model call goes through
  `meteredModel` (`packages/infra/src/metered-model.ts`), which writes one row the moment the call
  returns. The tool registry writes one row per completed tool call. Printing and postage for approved
  letters write a `third_party` row. Callers only label a call (`meter`); they never write cost rows.
- **Newly covered:** the claim-this-site draft, idea-card Q&A and every planner call. Before, these
  model calls were either unrecorded or recorded only by the graph runtime.
- **Spend caps, the digest and the Budgets page read `cost_events`** (`costEvents.spendSince`):
  `mode = 'live' AND dry_run = 0`, per playbook from the new `playbook` column, with `exclude_steps`
  matched on the new `step_id` column. Migration 0025 adds both columns and an index, with a down file.
  `runLog.spendSince` (the `run_log ⨝ tasks` join that would have crossed the database split) is removed.
- **What `dry_run` means:** the cost wasn't actually incurred, i.e. a simulated paid action, recorded at
  £0 with its would-be price in `unit_price_gbp`. A real model call is never `dry_run`, even while
  external actions run dry. Fake-model calls are marked `synthetic` but priced as before, so the caps
  and budget gates still bite in tests. Sandbox and planner spend is recorded under its own mode and is
  never live.
- **Bug fixed on the way:** the call that pushed a task over a cap used to lose its cost, because the
  cap check ran before the cost was recorded. It's now recorded first.
- **Not covered:** the website extractor in the bulk ingestion scripts
  (`packages/verification/src/sources/website/ingest.ts`) uses its own model in Node scripts run by
  hand. Its spend still isn't on the ledger.

## 2026-11-26 — GitHub Actions is the primary deploy path

- **New workflow `.github/workflows/deploy.yml`**, started by hand only (`workflow_dispatch`; nothing
  deploys on push). It runs the same checks as CI, then `pnpm cf:deploy`, then fails if
  `https://engine.ejtech.co.uk/api/health` answers 200 without a login (Access must stay in front).
  One deploy at a time (concurrency group). The secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` live on the GitHub environment `production`, never the repo.
- **Why:** Archie can deploy from the GitHub app on a phone, and every deploy passes the full check
  first. It uses the repo's pinned wrangler (`pnpm cf:deploy`) rather than `cloudflare/wrangler-action`,
  so the laptop and CI run exactly the same command.
- **The laptop is the fallback** (`wrangler login`). **A cloud session never deploys**: its
  proxy-injected token breaks wrangler's asset upload (see 2026-11-24). Runbook: `docs/runbooks/deploy.md`.

## 2026-11-26 — Graph run state in Durable Objects (data layer plan, step 1)

- **One `RunState` Durable Object per graph run** (named by the run id) holds that run's node runs
  (with the recorded model output) and its state values. It's a plain `DurableObject` on its own
  SQLite, not the Agents SDK. It runs the same run-store SQL (`packages/storage/src/run-store.ts`) as
  the local store, through a small adapter over `ctx.storage.sql` (`do-sql.ts`).
- **At the end of a run** (the workflow's `finish` step), the run is archived as one object,
  `runs/<run_id>/archive.json`, in the new R2 bucket `agent-engine-files`. Then the object is emptied
  with `deleteAll()`. Reading a closed run's node runs comes from the archive. A queue job delivered
  again after the run has ended is skipped, so no node runs twice and no cost is recorded twice.
- **Locally:** `data/runs.sqlite` and `data/blobs/` (`localRunState`). In tests and gates the run
  tables sit beside the test database. The run tables are named `run_node_runs` and
  `run_state_values`, so they never collide with the old `graph_*` tables. Those old tables stay in
  D1, unused, until step 2's split migration drops them.
- **Workflows keep their own state.** On Cloudflare, step results and events are no longer mirrored
  into D1 (one write per step that nothing on Cloudflare read). **`workflow_instances` stays as the
  thin index** (one row per instance; written at start, pause and end), instead of a new
  `workflow_index` table. It has the same effect without a rename. The full step and event tables
  remain for the local engine only.
- **New bindings, no IDs:** `RUN_STATE` (Durable Object migration tag v3) and `FILES` (R2). Wrangler
  creates them at Archie's next deploy. Nothing was created remotely.
- **Flag:** a run that never reaches `finish` (an instance terminated by hand) keeps its object until
  someone closes it. It's tiny, but it's billed for storage.

## 2026-11-26 — Three databases (data layer plan, step 2)

- **Core stays `agent-engine`**, with its 0001–0025 history unchanged; it moves to
  `migrations/core/`. Two new D1 databases are added:
  - `agent-engine-facts` (binding FACTS): verification, universe, measurement and the opportunity
    engine; 21 tables, with claims' append-only triggers kept word for word;
  - `agent-engine-telemetry` (binding TELEMETRY): `run_log`, `trigger_stats`, `runtime_status` and
    `dead_letters`.

  Each new database starts from a baseline copied exactly from today's schema. The other append-only
  triggers (cost_events, revenue_events, pool_events, idea_thread) stay in core, unchanged.
- **One routing driver.** Each SQL statement goes to the database of the tables it names, using the
  placement map (`placement.ts`). A statement or a batch that names two databases is refused.
  This kept all 335 queries as they were. A test scans every SQL string in the storage package; only
  one crossed (the local engine's `steps_done` count), and it's now two statements.
- **Cross-database foreign keys removed:** `opportunities.run_id → runs` (core is rebuilt without it;
  the values are kept) and `run_log.task_id → tasks` (the telemetry baseline has no foreign key).
- **Core migration `0026_split` drops the moved tables.** Remotely they're empty. Locally, opening an
  older single-file `dev.sqlite` first copies every moved table's rows into its new file, so
  ingested Companies House data and the run log survive. It also drops the unused `graph_node_runs`
  and `graph_state_values` (superseded in step 1) and the workflow step and event tables, which are
  now local-only in `dev-runtime.sqlite`.
- **Local file names:** `dev.sqlite` stays the core file (rather than being renamed `core.sqlite`),
  with `dev-facts.sqlite`, `dev-telemetry.sqlite` and `dev-runtime.sqlite` beside it. Every script that
  reads `AE_DB` keeps working.
- **`pnpm cf:deploy`** applies migrations to all three databases. The deploy token needs R2 edit too
  (`docs/runbooks/deploy.md`).

## 2026-11-26 — Large bodies to R2 through one helper (data layer plan, step 3)

- **One helper, `packages/storage/src/bodies.ts`** (Archie's request), is the only code that decides
  inline or R2. A body of 8 KiB or less stays in its row; anything larger goes to `agent-engine-files`
  (`data/blobs` locally, memory in tests), and the row keeps its key, size and SHA-256. Reads check
  size and hash and fail loudly. Only storage methods call the helper, so callers still get the plain
  body. A test fails if any code outside `packages/storage` names a `*_key` body column.
- **Always in R2:** letter PDFs (now stored as bytes, not base64; the API still hands back base64)
  and demo pages.
- **Inline or R2:** outbox and mailbox bodies, note versions, run log steps (tool calls and output
  together) and graph nodes' recorded model outputs. The run archive is self-contained.
- **Schema, plain `ADD COLUMN` only:** each body column keeps its name and `NOT NULL` and holds `''`
  when the body is in R2, beside new `_key`, `_size` and `_sha256` columns. Migrations: core
  `0027_bodies`, telemetry `0002_bodies`, each with a down file. Rows written before keep working
  inline. No table rebuilds were needed.
- **Rule 20:** the leak audit now also searches stored bodies (where the store can list them: locally
  and in tests).

## 2026-11-26 — Cheap dashboard reads (data layer plan, step 4)

- **`daily_rollups`** (core `0028`, WITHOUT ROWID). Its key is `(day, revenue_path, playbook, mode,
  synthetic, dry_run)`, with `dry_run` included at Archie's request. Each cost or revenue event writes
  its rollup upsert in the **same batch**, so a rollup always equals the sum of its events. A
  duplicate event fails the whole batch and isn't counted twice. A graph run's end adds one to `runs`.
  Existing events are backfilled.
- **Live spend is `mode = 'live' AND dry_run = 0`**: never sandbox, probe or planner money, and never a
  dry run. Synthetic rows still count toward the caps (as before), so the budget gates bite in
  simulated worlds; real-money views exclude them.
- **Spend caps, the digest and Budgets read the rollups** whenever `since` is a day boundary, which
  covers all three. Steps the caps leave out (printing and postage) are taken off from their own
  events, a small indexed read, because step isn't part of the rollup key; that keeps
  `exclude_steps` a config choice, not baked in at write time. Any other `since` sums the events.
- **Revenue in the rollups:** Stripe test-mode money is stored as `dry_run = 1` (test money isn't
  real money).
- **KV cache, 60 seconds** (KV's minimum), for Home, unit economics, Board and the CRM list only. It
  runs after Access, and its key is the path plus the sorted query. The cost tracker, caps and Budgets
  never read it.
- **D1 sessions.** A GET reads through a session that starts from Archie's bookmark (cookie: one per
  database, HttpOnly, `/api` only), so Archie always reads their own writes. Any other request uses
  `first-primary`. Turning replication on is a dashboard switch per database (runbook). For Archie,
  near the primary, it helps little; it's there for the public x402 check.

## 2026-11-26 — Access app for engine.ejtech.co.uk; Access vars filled in

- **Access app "engine"** (self-hosted, destination `engine.ejtech.co.uk` only, policy "Archie only":
  Allow, Include → Archie's email, login method Cloudflare). It does not cover `ejtech.co.uk` or `www`,
  which serve the `agent-house` Worker. The earlier runbook assumed a domain-wide app that never existed.
- **`wrangler.jsonc` vars:** `ACCESS_TEAM_DOMAIN = https://mute-rice-0c6e.cloudflareaccess.com` (full
  origin: `access.ts` builds `${teamDomain}/cdn-cgi/access/certs` and uses it as the JWT issuer) and
  `ACCESS_POLICY_AUD` = the app's AUD tag. Neither is secret.
- **Deploy check tightened.** The first deploy's check passed on a 403 that came from the Worker's own
  lock while no Access app existed. It now requires both `/` and `/api/health` to redirect to
  `*.cloudflareaccess.com` without a login.
