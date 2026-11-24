# Deploying to Cloudflare

What gets deployed: one Worker called `agent-engine` that serves the dashboard and `/api/*`, plus one
D1 database called `agent-engine`. It lives at **https://engine.ejtech.co.uk** (a Workers Custom
Domain, set in `apps/api/wrangler.jsonc` → `routes`). The `workers.dev` URL is switched off, because
it sits outside the ejtech.co.uk Access app.

It doesn't touch the older `agent-house` Worker; both can run side by side.

## One-time setup

1. **Cloudflare account on the Workers Paid plan** ($5/month). Queues and Workflows need it.
2. **ejtech.co.uk is an active zone on the same Cloudflare account.**
3. **No existing DNS record for `engine.ejtech.co.uk`.** The deploy creates it. A Custom Domain can't
   be created on a hostname that already has a CNAME record, so delete one if it's there.
4. **Log in from your laptop:** `pnpm --filter @ae/api exec wrangler login` (opens a browser).
   (Or, for automated deploys, create an API token — see "API token" below.)

## Deploy

```bash
pnpm install
pnpm cf:deploy
```

This builds the dashboard, deploys the Worker, attaches `engine.ejtech.co.uk` (creating its DNS record
and certificate), creates the D1 database the first time, then applies any pending database migrations.

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
