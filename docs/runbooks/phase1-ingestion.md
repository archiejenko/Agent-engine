# Phase 1 ingestion: from nothing to 10,000 verified companies

Run on your laptop (Companies House and ONS downloads are several GB). Every step is resumable and
safe to re-run. Check progress any time with `pnpm gate:phase1` or the dashboard (`pnpm dev`).

## 0. Rehearse first (optional, 5 minutes, no key, no downloads)

```bash
pnpm rehearse --count 20000            # synthetic data → data/rehearsal.sqlite
AE_DB=data/rehearsal.sqlite pnpm gate:phase1
```

## 1. Get the files (no key needed)

```bash
pnpm sources:download                  # bulk company file + last 15 monthly accounts archives → data/sources
```

The ONS postcode file must be downloaded by hand (its link changes each release):
ONS Open Geography Portal → search **"ONS Postcode Directory"** (ONSPD) or **"National Statistics
Postcode Lookup"** (NSPL) → latest release → download the zip → put the main CSV in `data/sources/`.
Note the release date (e.g. August 2026 → `2026-08-01`).

## 2. Build the universe (no key needed, ~20–40 minutes)

```bash
pnpm ingest:universe --companies data/sources/BasicCompanyDataAsOneFile-2026-11-01.zip \
  --postcodes data/sources/ONSPD_AUG_2026_UK.csv --ons-date 2026-08-01
```

You'll see how many Greater Manchester companies there are and why each was in or out.

## 3. Staff numbers from filed accounts (no key needed, ~30–90 minutes)

```bash
pnpm ingest:accounts data/sources/Accounts_Monthly_Data-*.zip
```

Applies the 5–100 staff rule. Companies with no staff figure stay in, flagged `staff_unknown`.

## 4. Companies House API (needs the key, ~7 hours for 10,000)

1. Create a free account at developer.company-information.service.gov.uk → "Your applications" →
   create an application → create a **REST** API key.
2. Put it in `.dev.vars`: `CH_API_KEY=...` (that file is git-ignored; never paste the key anywhere else).
3. Check the assumptions in `docs/sources/companies-house.md` (≈ 15 minutes), then:

```bash
pnpm ingest:companies --limit 50       # small first run: check the output and pnpm gate:phase1
pnpm ingest:companies                  # everything; leave it running. Ctrl+C is safe — run it again to continue.
```

## 5. Gate evidence

```bash
pnpm gate:phase1
```

Prints companies ingested, % anchored, facts by status, rejections and dropped source fields, then runs
the asOf and licensed-lane gate tests.

## Undo

Every step is a run with a `run_id` (shown in the output). `pnpm rollback <run_id>` withdraws it and
recomputes the affected facts. Nothing is deleted.
