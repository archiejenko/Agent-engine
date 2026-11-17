# Keys: setting up Cloudflare Secrets Store (v3 Phase 5, decision D4)

API keys are **write-only**. You paste a key once on **Controls → Keys**. The Worker passes it straight to
Cloudflare Secrets Store and keeps nothing, so nobody can view it again: not the dashboard, the database,
`brain/`, a log or an agent. Only the tool registry reads it, and only when a tool actually acts (never in a
dry run).

Checked against Cloudflare's docs on 2026-11-17. Secrets Store is still marked **beta**, with **one store
per account**.

## One-off setup

1. **Create the store.** Cloudflare dashboard → Secrets Store. The first store is created automatically
   when you open it. Or run `npx wrangler secrets-store store create agent-engine --remote`. Copy the
   **store ID**.
2. **Create a narrow token for the Worker.** My Profile → API Tokens → Create custom token, with
   **Account → Secrets Store → Edit** and nothing else, for your account only. The docs call this
   permission "Account Secrets Store Edit"; some pages call it "Secrets Store Write". It can't deploy
   code, so it is far narrower than a Workers token.
3. **Give the Worker the token, as a Worker secret.** This is the one key you set by hand:
   `cd apps/api && npx wrangler secret put CF_SECRETS_TOKEN`
4. **Set two variables** in `apps/api/wrangler.jsonc` → `vars`: `CF_ACCOUNT_ID` (your account ID) and
   `SECRETS_STORE_ID` (the store ID from step 1). These aren't secret.
5. **Bind each key the engine uses.** Add this to `apps/api/wrangler.jsonc`, with your store ID. The names
   come from `packages/config/src/keys.json`:

```jsonc
"secrets_store_secrets": [
  { "binding": "ANTHROPIC_API_KEY",     "store_id": "<STORE_ID>", "secret_name": "ANTHROPIC_API_KEY" },
  { "binding": "CH_API_KEY",            "store_id": "<STORE_ID>", "secret_name": "CH_API_KEY" },
  { "binding": "CH_STREAM_KEY",         "store_id": "<STORE_ID>", "secret_name": "CH_STREAM_KEY" },
  { "binding": "EMAIL_API_KEY",         "store_id": "<STORE_ID>", "secret_name": "EMAIL_API_KEY" },
  { "binding": "STRIPE_SECRET_KEY",     "store_id": "<STORE_ID>", "secret_name": "STRIPE_SECRET_KEY" },
  { "binding": "STRIPE_WEBHOOK_SECRET", "store_id": "<STORE_ID>", "secret_name": "STRIPE_WEBHOOK_SECRET" }
]
```

   Create each secret first: save it once on the Keys page, or use
   `npx wrangler secrets-store secret create <STORE_ID> --name EMAIL_API_KEY --scopes workers --remote`.
   Then deploy. The binding may refuse to deploy if the secret doesn't exist yet. **Verify this at cutover.**
6. **Check it.** Open Controls → Keys. Each key should show "saved, not used yet", then "working" after
   its first live use.

## Fallback during cutover

A plain Worker secret with the same name (`wrangler secret put ANTHROPIC_API_KEY`) still works. The
adapter reads a Secrets Store binding or a Worker secret, whichever is there, so you can move keys
across one at a time.

## When a key fails

If a provider refuses a key (HTTP 401/403):
- the key shows **failing**;
- **only the playbooks listed against it pause**, and their tasks wait untouched;
- a **"Key failing"** decision appears in Needs you.

Save a new value to resume them. The decision then closes on its own. "Try the same key again" resumes
them too, for a provider outage. If nobody decides, the safe default keeps them paused.

## Unverified until cutover

The list call that finds an existing secret's ID, and the shape of its response (`result: [{ id, name }]`),
weren't shown in the docs. Both are isolated in `packages/ports/src/keys.ts`, and the create and replace
calls follow the docs. First real save: watch for a "list failed" or "update failed" message on the Keys
page.
