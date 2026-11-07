# Deploying to Cloudflare

What gets deployed: one Worker called `agent-engine` that serves the dashboard and `/api/*`, plus one
D1 database called `agent-engine`. It lives at `https://agent-engine.<your-subdomain>.workers.dev`.

## One-time setup

1. **Cloudflare account on the Workers Paid plan** ($5/month).
2. **Log in from your laptop:** `pnpm --filter @ae/api exec wrangler login` (opens a browser).
   (Or, for automated deploys, create an API token — see "API token" below.)

## Deploy

```bash
pnpm cf:deploy
```

This builds the dashboard, deploys the Worker (creating the D1 database the first time), then applies
any pending database migrations.

## Turn on Cloudflare Access (one-time, ~2 minutes)

Until you do this, the Worker refuses every `/api` request with `access_not_configured` — that's
deliberate (it fails closed).

1. Cloudflare dashboard → **Workers & Pages** → `agent-engine` → **Settings** → **Domains & Routes**.
2. Next to `workers.dev`, click **Enable Cloudflare Access**.
3. Click **Manage Cloudflare Access** and make sure the policy allows only your email.
4. On that Access application page, copy:
   - the **Application Audience (AUD) tag**
   - your **team domain** (looks like `https://<team-name>.cloudflareaccess.com`; also under
     Zero Trust → Settings → Custom Pages / Team domain).
5. Put both into `apps/api/wrangler.jsonc` under `vars` (`ACCESS_TEAM_DOMAIN`, `ACCESS_POLICY_AUD`).
   They are **not secret** (they identify the app; they don't grant access).
6. `pnpm cf:deploy` again.

## Check it

- Open the workers.dev URL in a private window → you should get the Cloudflare Access login.
- After logging in with your email → the dashboard shows **API health: ok, worker, 1 migration**.
- `curl https://agent-engine.<subdomain>.workers.dev/api/health` without logging in → blocked.

## API token (for CI / automated deploys)

Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template,
then add **Account → D1 → Edit**. Store it as `CLOUDFLARE_API_TOKEN`, and your account id as
`CLOUDFLARE_ACCOUNT_ID` (GitHub Actions secrets for CI). Never commit it.

## Rollback

`pnpm --filter @ae/api exec wrangler rollback` returns the Worker to the previous version.
Database migrations only ever add things in Phase 0–1; a bad migration is fixed by a new migration.
