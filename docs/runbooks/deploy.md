# Deploying to Cloudflare

What gets deployed: one Worker called `agent-engine` that serves the dashboard and `/api/*`, plus one
D1 database called `agent-engine`. It lives at **https://engine.ejtech.co.uk** (a Workers Custom
Domain, set in `apps/api/wrangler.jsonc` → `routes`). The `workers.dev` URL is switched off, because
it sits outside the ejtech.co.uk Access app.

It doesn't touch the older `agent-house` Worker; both can run side by side.

## How deploys work (three places, one of which never deploys)

| Where | Role | Why |
|---|---|---|
| **GitHub Actions** (`.github/workflows/deploy.yml`) | **Primary.** Use this every time. | Runs the full check, then `pnpm cf:deploy`, then confirms the site is still behind Access. Works from your phone. |
| **Your laptop** | **Fallback**, if GitHub Actions is down or broken. | Same `pnpm cf:deploy`, logged in with `wrangler login`. |
| **A Claude cloud session** | **Never deploys.** | Its Cloudflare token is added by a network proxy, and that clashes with the one-off upload ticket wrangler uses for the dashboard files. So `wrangler deploy` can't finish there. Cloud sessions write code, push it, and can create things like queues and D1 databases, but you publish the Worker. |

Already done (2026-11-24, from a cloud session): the queues `ae-jobs` and `ae-jobs-dlq`; the D1
database `agent-engine` (its id is in `wrangler.jsonc`) with its migrations applied; and a check that
`ejtech.co.uk` is an active zone with no existing record for `engine.ejtech.co.uk`.

## Deploy from GitHub (primary)

You do this once: the GitHub environment **production** holds two secrets, `CLOUDFLARE_API_TOKEN`
and `CLOUDFLARE_ACCOUNT_ID` (done 2026-11-26; see "API token" below for the token's permissions).

Each deploy:

1. **Start it.** GitHub app → the `Agent-engine` repo → **Actions** → **Deploy** → **Run workflow**
   → branch `claude/nifty-curie-91l1nq` → **Run workflow**. (On github.com it's the same path: Actions
   tab → Deploy in the left list → the **Run workflow** button.)
2. **Wait** about 5–10 minutes. The run goes through: install → typecheck → lint → build → tests →
   **Deploy to Cloudflare** → **Check the site is still behind Access**.
3. **Read the result.**
   - Green tick: it's live. The deploy step's log ends with "No migrations to apply", or lists the
     migrations it applied.
   - Red cross on a check or test step: nothing was deployed. The live site is unchanged.
   - Red cross on **Check the site is still behind Access**: the new version **is** live, and
     `/api/health` answered without a login. Fix the Access app at once (see "Connect Cloudflare
     Access"), or roll back.
4. **Look at it.** Open https://engine.ejtech.co.uk in a private window. It should ask for your email
   and then show **API health: ok**.

It only runs when you start it. Nothing deploys on push. Two runs never overlap: a second one waits.

## Why a deploy can fail, and what stops it

The GitHub token can **publish** the `agent-engine` Worker and apply D1 migrations. It can't
**create** Cloudflare resources, and shouldn't. So every resource the Worker uses is created by hand
first and its id pinned in `apps/api/wrangler.jsonc`.

| Cause | What it looks like | Guard |
|---|---|---|
| A new binding without an id (D1, KV) | "bindings need to be provisioned", then `Authentication error [10000]` | `apps/api/src/wrangler-config.test.ts` fails in the **Tests** step, before anything is deployed. Create the resource (from a cloud session, the Cloudflare dashboard or `wrangler … create` on the laptop), pin its id, push. |
| A bound resource that doesn't exist (R2 bucket, queue) | `R2 bucket '…' not found [10085]` | Create it before pushing the binding. Current set: D1 `agent-engine`, `agent-engine-facts`, `agent-engine-telemetry`; R2 `agent-engine-files`; KV `agent-engine-cache`; queues `ae-jobs`, `ae-jobs-dlq`; Workflows `ae-engine`, `ae-graph`. |
| Token scope | `No access to the specified service` | Token's Workers permission: **All Workers** (Admin to create, Editor after). Plus Zone → Workers Routes → Write on `ejtech.co.uk`, and D1 Edit. |
| A migration fails | the **Deploy to Cloudflare** step stops at `wrangler d1 migrations apply` | Migrations run **before** the Worker is published, so a failure leaves the old code live and nothing half-done. Migrations must stay additive (old code must still work on the new schema). |
| A Durable Object class without a migration tag | wrangler refuses the deploy | Caught by the same config test. |
| Access missing or misconfigured | **Check the site is still behind Access** fails | The page must redirect to `*.cloudflareaccess.com`; `/api/health` must answer 3xx, 401 or 403. Access vars are format-checked by the config test. |
| Another session pushes while you deploy | the run deploys whatever is on the branch at that moment | The config test runs on that same commit, so an unpinned binding still stops it before deploying. |

## Deploy from your laptop (fallback)

Use this only if the GitHub route isn't working.

1. **Get the code.** `git pull` on `claude/nifty-curie-91l1nq`, then `pnpm install` (Node 22; run
   `corepack enable` if `pnpm` is missing).
2. **Log in.** `pnpm --filter @ae/api exec wrangler login`, approve it in the browser, then check
   with `pnpm --filter @ae/api exec wrangler whoami`.
3. **Deploy.** `pnpm check`, then `pnpm cf:deploy`. It publishes the `agent-engine` Worker, attaches
   `engine.ejtech.co.uk` and applies pending migrations. It does **not** touch `agent-house`.
4. **Check it.** `curl -sI https://engine.ejtech.co.uk/api/health` must be blocked (a redirect to
   cloudflareaccess.com, or a 403), never a 200.

## After the first deploy

1. **Fill in Access.** In Zero Trust, open your ejtech.co.uk Access app and copy two values into
   `apps/api/wrangler.jsonc` → `vars`: the Application Audience (**AUD**) tag → `ACCESS_POLICY_AUD`,
   and `https://<team>.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`. Commit, push, and run the
   **Deploy** workflow again. (Until then the dashboard loads but every `/api` call is refused with
   `access_not_configured`, which is deliberate.)
2. **Check it.** In a private window, https://engine.ejtech.co.uk asks for your email, then shows
   **API health: ok** with the current migration count.
3. **Optional, one click each:** Vault → Ideas sheet → **Import into the backlog**, for the 500 seeded
   ideas and for your 41 ranked ideas.
4. **Tidy up.** The cloud session's Cloudflare token is saved on the `agent-engine` cloud environment.
   You can delete that network secret, or the token itself in Cloudflare. Deploys use the separate
   GitHub token.

If the deploy step fails on Queues, Workflows or Durable Objects, check the account is on **Workers Paid**.

## One-time setup

1. **Cloudflare account on the Workers Paid plan** ($5/month). Queues and Workflows need it.
2. **ejtech.co.uk is an active zone on the same Cloudflare account.**
3. **No existing DNS record for `engine.ejtech.co.uk`** (checked 2026-11-24: none). The deploy creates it. A Custom Domain can't
   be created on a hostname that already has a CNAME record, so delete one if it's there.
4. **A deploy credential:** the GitHub API token (see "API token" below) for the primary route, and
   `pnpm --filter @ae/api exec wrangler login` on your laptop for the fallback.

## What `pnpm cf:deploy` does

**The data layer's resources (2026-11-26).** All are pinned in `wrangler.jsonc`, so a deploy creates
nothing:
- the D1 databases `agent-engine-facts` and `agent-engine-telemetry`;
- the KV namespace `agent-engine-cache`;
- the `RunState` Durable Object class (migration tag v3), which a deploy sets up itself.

The R2 bucket `agent-engine-files` exists (created 2026-11-26 21:06 UTC by deploy run 3) and the
`FILES` binding names it; a test pins that. Never use `agent-house-files`.

`pnpm cf:deploy` applies each database's migrations (DB, FACTS, TELEMETRY) and then publishes. On
`agent-engine` (core), `0026_split` drops the tables that moved to facts and telemetry (empty
remotely); `0029_indexes` rebuilds two small tables WITHOUT ROWID, keeping their rows. Both still work
with the previous Worker code, since migrations run first.

To check: `/api/health` (behind Access) reports `databases: { core: 30, facts: 3, telemetry: 3 }`.

**Turn on read replication (free, optional, once).** In the Cloudflare dashboard, go to Storage &
databases → D1. For each of `agent-engine`, `agent-engine-facts` and `agent-engine-telemetry`, open
Settings → **Read replication** → Enable. The Worker already reads through D1 sessions with a bookmark
cookie, so you always see your own writes. Without replication, the same code just reads the primary.

Both routes run the same command. It builds the dashboard, deploys the Worker, attaches `engine.ejtech.co.uk` (creating its DNS record
and certificate), then applies any pending database migrations. On a brand-new account, create the
queues first (`wrangler queues create ae-jobs` and `ae-jobs-dlq`) and the database
(`wrangler d1 create agent-engine`, with its id put in `wrangler.jsonc`); `wrangler deploy` doesn't
create them.

## Connect Cloudflare Access (one-time, ~2 minutes)

Until you do this, the Worker refuses every `/api` request with `access_not_configured`. That's
deliberate (it fails closed): the dashboard page loads but shows no data.

The edge check comes from the Access app that covers the whole domain:

1. Zero Trust → **Access controls** → **Applications** → the self-hosted app with destinations
   `ejtech.co.uk` and `*.ejtech.co.uk`. Its only policy: **Allow**, Include → Emails → your address.
   (If it doesn't exist yet, create it with exactly that.)
2. On that app: **Edit** → **Additional settings** → copy the **Application Audience (AUD) Tag**.
3. Copy your **team domain**: `https://<team-name>.cloudflareaccess.com` (Zero Trust → Settings).
4. Put both into `apps/api/wrangler.jsonc` under `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_POLICY_AUD`).
   They are **not secret** (they identify the app; they don't grant access).
5. Run the **Deploy** workflow again.

The AUD tag never changes unless you delete and recreate that Access app. If you ever do, update the
var and redeploy.

## Check it

- Open https://engine.ejtech.co.uk in a private window → you should get the Cloudflare Access login.
- After logging in with your email → the dashboard shows **API health: ok**.
- `curl https://engine.ejtech.co.uk/api/health` without logging in → blocked.

## Public routes (later, not needed for the dashboard)

The same Worker also serves public paths (`/x402/*`, `/webhooks/*`, `/demo/*`, `/stop/*`, `/claim/*`,
`/s/*`, `/public/*`). Behind the domain-wide Access app nobody else can reach them, which is fine while
everything is in dry-run. When one goes live, give it its own hostname (for example
`api.ejtech.co.uk`) as a second Custom Domain on this Worker, and add a separate Access app for that
hostname with the action **Bypass**. The more specific app wins over the wildcard.

## API token (GitHub Actions)

Cloudflare dashboard → **Account API tokens** → **Create Token** → "Edit Cloudflare Workers"
template, then add **Account → D1 → Edit** and **Account → Workers R2 Storage → Edit** (the
data layer's file bucket). Scope it to your one account and the `ejtech.co.uk` zone.
Save it as the secret `CLOUDFLARE_API_TOKEN` on the GitHub environment **production** (repo →
Settings → Environments → production), next to `CLOUDFLARE_ACCOUNT_ID`. Never commit it. To replace
it, create a new token, update the secret, then delete the old token in Cloudflare.

## Rollback

Fastest: Cloudflare dashboard → Workers & Pages → `agent-engine` → **Deployments** → pick the previous
version → **Rollback**. From the laptop: `pnpm --filter @ae/api exec wrangler rollback`. Or revert the
bad commit, push, and run the **Deploy** workflow.
Database migrations only ever add things in Phase 0–1; a bad migration is fixed by a new migration.
