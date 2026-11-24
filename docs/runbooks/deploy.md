# Deploying to Cloudflare

What gets deployed: one Worker called `agent-engine` that serves the dashboard and `/api/*`, plus one
D1 database called `agent-engine`. It lives at **https://engine.ejtech.co.uk** (a Workers Custom
Domain, set in `apps/api/wrangler.jsonc` → `routes`). The `workers.dev` URL is switched off, because
it sits outside the ejtech.co.uk Access app.

It doesn't touch the older `agent-house` Worker; both can run side by side.

## First deploy: your laptop checklist (everything else is done)

Done already (2026-11-24, from the cloud session):
- the queues `ae-jobs` and `ae-jobs-dlq`;
- the D1 database `agent-engine` (its id is in `wrangler.jsonc`), with all 24 migrations applied;
- `ejtech.co.uk` checked as an active zone on your account, with no existing record for
  `engine.ejtech.co.uk`.

The cloud session couldn't publish the Worker itself. Its token is added by a proxy, and that clashes
with the one-off ticket wrangler uses to upload the dashboard files. So the publish runs from your
laptop:

1. **Get the code.** `git pull` on branch `claude/nifty-curie-91l1nq`, then `pnpm install`. You need
   Node 22; run `corepack enable` if `pnpm` is missing.
2. **Log in.** `pnpm --filter @ae/api exec wrangler login`, and approve it in the browser. Then
   `pnpm --filter @ae/api exec wrangler whoami` should show your account.
3. **Deploy.** `pnpm cf:deploy`. It publishes the `agent-engine` Worker and attaches
   `engine.ejtech.co.uk`. It should end with "No migrations to apply". It does **not** touch
   `agent-house`.
4. **Fill in Access.** In Zero Trust, open your ejtech.co.uk Access app and copy two values into
   `apps/api/wrangler.jsonc` → `vars`:
   - the Application Audience (**AUD**) tag → `ACCESS_POLICY_AUD`;
   - `https://<team>.cloudflareaccess.com` → `ACCESS_TEAM_DOMAIN`.

   Then run `pnpm check`, commit ("Fill in Access vars for engine.ejtech.co.uk"), push, and run
   `pnpm cf:deploy` again.
5. **Check it.**
   - `curl -sI https://engine.ejtech.co.uk/api/health` must be blocked (a redirect to
     cloudflareaccess.com, or a 403), never a 200.
   - In a private window, https://engine.ejtech.co.uk asks for your email, and then the dashboard shows
     **API health: ok** with **24** migrations.
6. **Optional, one click each:** Vault → Ideas sheet → **Import into the backlog**, for the 500 seeded
   ideas and for your 41 ranked ideas.
7. **Tidy up.** The cloud session's Cloudflare token is saved on the `agent-engine` cloud environment.
   You can delete that network secret, or the token itself in Cloudflare, once the deploy works.

If step 3 fails on Queues, Workflows or Durable Objects, check the account is on **Workers Paid**.

## One-time setup

1. **Cloudflare account on the Workers Paid plan** ($5/month). Queues and Workflows need it.
2. **ejtech.co.uk is an active zone on the same Cloudflare account.**
3. **No existing DNS record for `engine.ejtech.co.uk`** (checked 2026-11-24: none). The deploy creates it. A Custom Domain can't
   be created on a hostname that already has a CNAME record, so delete one if it's there.
4. **Log in from your laptop:** `pnpm --filter @ae/api exec wrangler login` (opens a browser).
   (Or, for automated deploys, create an API token — see "API token" below.)

## Deploy

```bash
pnpm install
pnpm cf:deploy
```

This builds the dashboard, deploys the Worker, attaches `engine.ejtech.co.uk` (creating its DNS record
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
5. `pnpm cf:deploy` again.

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

## API token (for CI / automated deploys)

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template,
then add **Account → D1 → Edit**. Store it as `CLOUDFLARE_API_TOKEN`, and your account id as
`CLOUDFLARE_ACCOUNT_ID` (GitHub Actions secrets for CI). Never commit it.

## Rollback

`pnpm --filter @ae/api exec wrangler rollback` returns the Worker to the previous version.
Database migrations only ever add things in Phase 0–1; a bad migration is fixed by a new migration.
