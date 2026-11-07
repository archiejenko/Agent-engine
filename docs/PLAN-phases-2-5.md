# Plan: Phases 2–5 (keyless build)

Approved approach (2026-11-08): build all four phases now, on synthetic data, with every external
system behind an interface ("port") that has a **fake** implementation. Real implementations plug in
at cutover. Nothing external happens until Archie turns the global kill switch off.

## Ports (one interface, a fake now, a real adapter at cutover)

| Port | Fake (now) | Real (cutover) |
|---|---|---|
| `CompaniesHouseClient` (fetch) | fixture/synthetic responses | live API with `CH_API_KEY` |
| `ChangeStream` | scripted stream events | Companies House **Streaming API** (Phase 4) |
| `WebFetcher` / `WebsiteFinder` | recorded pages per domain | real HTTP fetch (+ robots.txt) |
| `ModelClient` | deterministic fake model returning recorded responses | Claude API (Agent SDK in the runner) |
| `EmailSender` / `Inbox` | outbox table / scripted replies | sending provider + inbox (Phase 5) |
| `X402Facilitator` | fake payment verification + fake ledger | x402 facilitator (testnet, then mainnet) |
| `PaymentProvider` (Stripe) | fake checkout + signed fake webhooks | Stripe Checkout + webhooks |
| `AlertChannel` | alert log table | webhook / email |
| `QueueBus` | in-memory queue | Cloudflare Queues |

## Phase 2 — Lead gen to drafts
Website ingestion (tier 3 site metadata; tier 5 `llm_extract` with evidence spans), triangulation and
conflict queue, signal library, `brain/frameworks/lead_gen_sme_web.md`, module runner (traces,
expected value, exploration, dedupe), tasks/queues/tool registry/run log/approvals/spend caps/kill
switches, agent runner executing playbooks with the role model, `sme_outreach` at L0, review queue.

## Phase 3 — Measurement and outcomes
Golden set tooling, accuracy + calibration per source/field, drift monitoring with source pause,
outcome logging, backtester (precision@20, lift vs random, calibration; states its point-in-time
mode), weight suggestions written into the framework note, weekly digests and margin report.

## Phase 4 — x402 company check
Paid endpoint with two tiers (cached; premium = live re-verification first), per-field confidence and
`last_verified_at`, open lane only, request log feeding an `x402_discovery` module, blind verifier with
adaptive sampling, and the **Companies House Streaming API**: a `ChangeStream` consumer that turns
company/officer/PSC/charge/filing change events into re-verification requests (and fresh claims) so
watched and recently-queried companies stay current without polling. Resumes from the last
timepoint after a disconnect. Real stream needs a separate stream key (cutover).

## Phase 5 — Alerts, human check, autonomy
Watch lists and change alerts (per alert or monthly), Stripe Checkout for a one-page human report,
outreach at L1 with sending (dry-run outbox), suppression list, UK rules, follow-up timers, autonomy
promotion with auto-demotion on any breach, kill switch and caps page.
