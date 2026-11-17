---
type: build-report
phase: v3-5
date: 2026-11-17
status: gate passed (synthetic); Secrets Store list call unverified against the live API
---

# v3 Phase 5: Controls and Keys (gate report)

## What was built

**Controls → Keys** (`/controls/keys`) lists every key the engine uses. For each one it shows:
- what the key is for;
- its status: not set, saved, working or failing;
- when it was last used and when it last worked;
- **which playbooks depend on it**.

You can paste a new value and save it. The page can never show a value back to you. The input clears
straight after saving, and the answer is just "saved".

**Where values go (decision D4).** On Cloudflare:
1. The page sends the value once to the Worker.
2. The Worker passes it to **Cloudflare Secrets Store**, using a token that can only edit secrets
   (`CF_SECRETS_TOKEN`).
3. The Worker keeps nothing.

Locally, keys come from `.dev.vars`, and anything saved on the page lasts for that session. The database
table `key_registry` holds **status only**: it has no column a value could go in.

**How keys are used (rule 20):**
- A tool declares the keys it needs (today only `send_email` needs one: `EMAIL_API_KEY`).
- The **tool registry** fetches a key only for a *live* call. A dry run never touches a provider, so it
  gets no key.
- After the call, the registry **removes every injected value** from the tool's result, its error message
  and the call log. Even a tool that echoes its key back can't pass it on, and tool results are the only
  route from tools to a model.
- The Claude client is built with its key at start-up. The key travels in the request header, never the body.
- **Only `packages/infra/src/keys.ts` reads keys.** A static test enforces that. Another static test
  stops the Worker reading any catalogue key straight from its environment.

**When a provider refuses a key** (HTTP 401/403):
- The key shows **failing**.
- **Only the playbooks listed against it** (`packages/config/src/keys.json`) pause. Their tasks wait
  untouched and don't take a queue slot; every other playbook keeps running.
- One **"Key failing"** decision appears in Needs you. Its safe default is *keep them paused*.
- Saving a new value resumes them and closes the decision. "Try the same key again" also resumes them,
  for a provider outage.

A missing key is refused **before anything happens**: no external action is recorded or attempted.

**Moving keys across.** Existing Worker secrets keep working: the adapter reads a Secrets Store binding or
a Worker secret of the same name, so keys can move over one at a time. The Worker now reads the Stripe,
Companies House and Claude keys through the key ring, and rebuilds at most once a minute, so a newly
saved key takes effect without a deploy.

## Gate (`docs/gates/v3-phase5.md`, run with `pnpm gate:v3 --phase 5`)

The gate uses a random canary value as the key, in a sandbox database with fake stores.

| Criterion | Status |
|---|---|
| Keys are write-only: saved through the API, never returned; bad names and values refused | passed (synthetic) |
| Injected only at the tool-registry boundary, only on live calls, scrubbed on the way out | passed (synthetic) |
| **Leak test**: no key value in a model request, a log line, any database table or `brain/` | passed (synthetic) |
| A refused key raises one decision and pauses only its dependants (real runner: an `sme_outreach` task waits while an `sme_letter` task runs to its approval gate) | passed (synthetic) |
| A missing key is refused before anything happens | passed (synthetic) |

**Other checks:**
- I ran the gate five times in a row to make sure it's stable.
- The Worker still builds with every binding (`wrangler deploy --dry-run`).
- The phone layout test covers the Keys page.

**A bug I caught on the way.** One gate check depended on luck. In about one run in three, the
`sme_letter` task never started, so the "only dependants pause" check passed or failed by chance. I now
run each task through the real runner directly, on separate companies, and require the letter task to
reach its approval step.

## Unverified until cutover

- **Secrets Store.** Saving a key for the first time uses a "list secrets" call to find whether the key
  already exists. Its response shape wasn't in the docs, so it's marked unverified. Creating and replacing
  a secret follow the docs exactly. Your first real save on the Keys page verifies it (cutover Stage 1b).
- **Deploying the bindings.** Deploying with a Secrets Store binding to a secret that doesn't exist yet may
  fail. Create each secret before adding its binding.

Next: the Milestone C report, and then I stop.
