import { basename } from "node:path";
import {
  type CompaniesHouseConfig,
  configVersion,
  loadCompaniesHouseConfig,
  rawConfig,
} from "@ae/config";
import type { Claim, UniverseConfig } from "@ae/contracts";
import type { EntityRow, Storage } from "@ae/storage";
import type { VerificationContext } from "../context.ts";
import { ingestClaims } from "../ingest.ts";
import {
  bulkEntityClaims,
  bulkRowToEntity,
  checkBulkHeader,
  trimRow,
} from "../sources/companies-house/bulk.ts";
import {
  type CompaniesHouseClient,
  fetchCompanyBundle,
} from "../sources/companies-house/client.ts";
import {
  accountsArchiveDate,
  employeesClaim,
  parseAccountsFileName,
  parseIxbrl,
} from "../sources/companies-house/ixbrl.ts";
import { mapCompanyBundle } from "../sources/companies-house/mapper.ts";
import { addOnsRow, detectOnsColumns, ladClaim } from "../sources/ons/postcodes.ts";
import { decideCandidate, decideStaff } from "../universe.ts";
import { forEachCsvRecord, forEachZipEntry, streamToString } from "./files.ts";

export type Log = (msg: string) => void;

const laterDate = (a: string, b: string) => (a >= b ? a : b);

async function startRun(storage: Storage, kind: string) {
  return storage.runs.start({
    kind,
    config_versions: {
      universe: await configVersion(rawConfig.universe),
      confidence: await configVersion(rawConfig.confidence),
      registry: await configVersion(rawConfig.registry),
      verification: await configVersion(rawConfig.verification),
      companies_house: await configVersion(rawConfig.companies_house),
    },
  });
}

async function flush(
  storage: Storage,
  ctx: VerificationContext,
  runId: string,
  fetchedAt: string,
  claims: Claim[],
) {
  if (claims.length === 0) return;
  await ingestClaims(storage, ctx, { run_id: runId, fetched_at: fetchedAt }, claims.splice(0));
}

/**
 * Step 1 — Universe (no API key needed).
 * ONS lookup → the region's postcodes. Bulk file → every company registered there → anchor registry
 * (entities) + candidate decision + claims for candidates (bulk snapshot + borough).
 */
export async function buildUniverse(
  storage: Storage,
  ctx: VerificationContext,
  universe: UniverseConfig,
  o: {
    companiesFile: string;
    companiesFileDate: string;
    postcodesFile: string;
    onsReleaseDate: string;
    log?: Log;
  },
) {
  const log = o.log ?? (() => {});
  const run = await startRun(storage, "universe");
  const fetchedAt = new Date().toISOString();
  try {
    const keep = new Set(universe.region.lad_codes);
    const ladByPostcode = new Map<string, string>();
    let cols: { postcode: string; lad: string } | null = null;
    const onsRows = await forEachCsvRecord(
      o.postcodesFile,
      (h) => {
        cols = detectOnsColumns(h.map((x) => x.trim()));
      },
      (row) => {
        if (cols) addOnsRow(ladByPostcode, row, cols, keep);
      },
    );
    log(
      `ONS: read ${onsRows.toLocaleString()} postcodes, ${ladByPostcode.size.toLocaleString()} in ${universe.region.name}`,
    );

    let seen = 0;
    const entities: EntityRow[] = [];
    const reasons: Record<string, number> = {};
    const claims: Claim[] = [];
    let candidates = 0;
    const writeEntities = async () => {
      const batch = entities.splice(0);
      if (!batch.length) return;
      await storage.entities.upsertMany(batch, run.run_id);
      const members = batch.map((e) => ({
        universe: universe.name,
        entity_id: e.entity_id,
        ...decideCandidate(e, universe),
      }));
      await storage.universe.setMany(members, run.run_id);
      for (const m of members) {
        reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
        if (!m.included) continue;
        candidates++;
        const e = batch.find((x) => x.entity_id === m.entity_id) as EntityRow;
        claims.push(
          ...(await bulkEntityClaims(
            e,
            o.companiesFileDate,
            basename(o.companiesFile),
            run.run_id,
            fetchedAt,
          )),
        );
        if (e.postcode && e.lad_code) {
          claims.push(
            await ladClaim(
              e.entity_id,
              e.name,
              e.postcode,
              e.lad_code,
              o.onsReleaseDate,
              basename(o.postcodesFile),
              run.run_id,
              fetchedAt,
            ),
          );
        }
      }
      if (claims.length > 2000) await flush(storage, ctx, run.run_id, fetchedAt, claims);
    };

    await forEachCsvRecord(
      o.companiesFile,
      (h) => checkBulkHeader(h),
      async (raw) => {
        seen++;
        const row = trimRow(raw);
        const e = bulkRowToEntity(row, ladByPostcode);
        // Only companies registered in the region enter the anchor registry in Phase 1.
        if (e?.lad_code) entities.push(e);
        if (entities.length >= 1000) await writeEntities();
        if (seen % 500_000 === 0)
          log(
            `bulk: ${seen.toLocaleString()} rows read, ${candidates.toLocaleString()} candidates`,
          );
      },
    );
    await writeEntities();
    await flush(storage, ctx, run.run_id, fetchedAt, claims);
    await storage.runs.finish(run.run_id, "succeeded");
    log(
      `bulk: ${seen.toLocaleString()} companies read; ${candidates.toLocaleString()} candidates in ${universe.region.name}`,
    );
    return {
      run_id: run.run_id,
      rows: seen,
      in_region: Object.values(reasons).reduce((a, b) => a + b, 0),
      candidates,
      reasons,
    };
  } catch (e) {
    await storage.runs.finish(run.run_id, "failed");
    throw e;
  }
}

/**
 * Step 2 — Staff numbers from filed accounts (no API key needed).
 * Reads accounts archives, parses only files for universe candidates, then applies the staff rule.
 */
export async function ingestAccounts(
  storage: Storage,
  ctx: VerificationContext,
  universe: UniverseConfig,
  o: { zipFiles: string[]; log?: Log },
) {
  const log = o.log ?? (() => {});
  const run = await startRun(storage, "accounts");
  const fetchedAt = new Date().toISOString();
  try {
    const candidates = new Set(
      (await storage.universe.list(universe.name, {}))
        .filter(
          (m) => m.reason !== "outside_region" && (m.included || m.reason.startsWith("staff_")),
        )
        .map((m) => m.entity_id),
    );
    const claims: Claim[] = [];
    let parsed = 0;
    let withEmployees = 0;
    for (const zip of [...o.zipFiles].sort()) {
      const published = accountsArchiveDate(basename(zip));
      if (!published) throw new Error(`Can't tell the publication date of ${basename(zip)}`);
      const files = await forEachZipEntry(
        zip,
        (name) => {
          const meta = parseAccountsFileName(name);
          return meta !== null && candidates.has(meta.companyNumber);
        },
        async (name, stream) => {
          const meta = parseAccountsFileName(name);
          if (!meta) return;
          parsed++;
          const r = parseIxbrl(await streamToString(stream));
          if (r.employees === null) return;
          withEmployees++;
          claims.push(
            await employeesClaim(
              {
                companyNumber: meta.companyNumber,
                employees: r.employees,
                periodEnd: r.periodEnd ?? meta.madeUpDate,
                // An archive can't publish accounts before their period ended.
                published: laterDate(published, r.periodEnd ?? meta.madeUpDate),
                fileRef: `${basename(zip)}#${name}`,
              },
              run.run_id,
              fetchedAt,
            ),
          );
          if (claims.length >= 2000) await flush(storage, ctx, run.run_id, fetchedAt, claims);
        },
      );
      log(`${basename(zip)}: ${files} accounts files for candidates`);
    }
    await flush(storage, ctx, run.run_id, fetchedAt, claims);
    const decided = await finaliseStaff(storage, universe, run.run_id);
    await storage.runs.finish(run.run_id, "succeeded");
    return { run_id: run.run_id, parsed, with_employees: withEmployees, ...decided };
  } catch (e) {
    await storage.runs.finish(run.run_id, "failed");
    throw e;
  }
}

/** Apply the 5–100 staff rule to every candidate, using the current employees_average fact. */
export async function finaliseStaff(storage: Storage, universe: UniverseConfig, runId: string) {
  const members = (await storage.universe.list(universe.name, {})).filter(
    (m) => m.reason === "candidate" || m.staff_flag !== "not_checked",
  );
  const updates = [];
  for (const m of members) {
    const fact = await storage.facts.getCurrent(m.entity_id, "employees_average");
    const employees =
      fact && fact.status !== "conflict" && typeof fact.value === "number" ? fact.value : null;
    updates.push({
      universe: universe.name,
      entity_id: m.entity_id,
      ...decideStaff(employees, universe),
    });
  }
  await storage.universe.setMany(updates, runId);
  return storage.universe.counts(universe.name);
}

/**
 * Step 3 — Companies House API for universe members (needs CH_API_KEY). Resumable: progress is kept
 * per company, so a crash or laptop sleep just continues. Re-runs hit the disk cache.
 */
export async function ingestCompanies(
  storage: Storage,
  ctx: VerificationContext,
  universe: UniverseConfig,
  client: CompaniesHouseClient,
  o: { limit?: number; maxAttempts?: number; config?: CompaniesHouseConfig; log?: Log },
) {
  const log = o.log ?? (() => {});
  const cfg = o.config ?? loadCompaniesHouseConfig();
  const job = `companies_house:${universe.name}`;
  const members = (await storage.universe.list(universe.name, { included: true })).map(
    (m) => m.entity_id,
  );
  const targets = o.limit ? members.slice(0, o.limit) : members;
  await storage.progress.ensure(job, targets, ["bundle"]);
  const run = await startRun(storage, "companies_house_api");
  const started = Date.now();
  let done = 0;
  try {
    for (;;) {
      const work = await storage.progress.next(job, 50, o.maxAttempts ?? 3);
      if (work.length === 0) break;
      for (const w of work) {
        try {
          const bundle = await fetchCompanyBundle(client, w.entity_id, cfg);
          const { claims, stats } = await mapCompanyBundle(bundle, run.run_id, cfg);
          for (const [k, v] of Object.entries(stats.dropped_source_fields))
            await storage.dropped.record("companies_house", k, run.run_id, v);
          await ingestClaims(
            storage,
            ctx,
            { run_id: run.run_id, fetched_at: bundle.fetched_at },
            claims,
          );
          await storage.progress.mark(
            job,
            w.entity_id,
            w.step,
            bundle.profile ? "done" : "skipped",
            bundle.profile ? undefined : "not found",
          );
        } catch (e) {
          if (
            (e as Error).name === "ChAuthError" ||
            (e as Error).constructor?.name === "ChAuthError"
          )
            throw e;
          await storage.progress.mark(
            job,
            w.entity_id,
            w.step,
            "failed",
            (e as Error).message.slice(0, 500),
          );
        }
        done++;
        if (done % 100 === 0) {
          const s = await storage.progress.summary(job);
          const perMin = done / ((Date.now() - started) / 60_000);
          log(
            `API: ${s.done.toLocaleString()} done, ${s.failed} failed, ${s.pending.toLocaleString()} left (${perMin.toFixed(0)}/min, ${client.calls} calls)`,
          );
        }
      }
    }
    await storage.runs.finish(run.run_id, "succeeded");
  } catch (e) {
    await storage.runs.finish(run.run_id, "failed");
    throw e;
  }
  return {
    run_id: run.run_id,
    progress: await storage.progress.summary(job),
    calls: client.calls,
    cache_hits: client.cacheHits,
  };
}
