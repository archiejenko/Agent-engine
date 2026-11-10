# Decision log

Newest first. Each entry: what we decided, why, and who approved it.

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
