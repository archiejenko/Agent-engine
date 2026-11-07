# Agent Engine

EJTECH's verification engine, opportunity engine and agent infrastructure layer.
Rules for every working session are in [`CLAUDE.md`](CLAUDE.md); the current plan is in
[`docs/PLAN-phase-0-1.md`](docs/PLAN-phase-0-1.md).

## Run it on your laptop

You need **Node.js 22** (https://nodejs.org) and that's it.

```bash
corepack enable          # one time: makes the `pnpm` command available
pnpm install             # one time (and after pulling changes)
pnpm dev                 # starts everything
```

Then open **http://localhost:5173**. You should see "API health: ok".

- The API runs on http://127.0.0.1:8787 (e.g. http://127.0.0.1:8787/api/health).
- All local data lives in one file: `data/dev.sqlite` (not committed to git).
- Stop with `Ctrl+C`.

## Check everything works

```bash
pnpm check     # typecheck + lint + all tests — the same thing GitHub runs on every push
```

## Deploy to Cloudflare

See [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md).

## Layout

| Folder | What it is |
|---|---|
| `apps/api` | The API (Hono). Runs on Node locally and as a Cloudflare Worker in production. |
| `apps/dashboard` | The internal dashboard (React). |
| `apps/agent-runner` | Runs agent playbooks (from Phase 2). |
| `packages/contracts` | The data contracts — the single source of truth for every shape of data. |
| `packages/config` | Business settings (universe, SIC exclusions, trust levels) as JSON. |
| `packages/storage` | The only code that talks to a database. |
| `packages/verification`, `opportunity`, `infra` | The three engines (filled in phase by phase). |
| `brain/` | Obsidian-compatible notes: frameworks, signals, weekly digests. |
| `playbooks/` | Agent playbooks. |
| `docs/` | Plan, decisions, known biases, runbooks. |
