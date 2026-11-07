import type { CompaniesHouseConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import {
  type CompaniesHouseClient,
  fetchCompanyBundle,
  ingestClaims,
  mapCompanyBundle,
  type VerificationContext,
} from "@ae/verification";
import type { X402Facilitator } from "./x402.ts";

/** Premium tier: pull the company from Companies House right now and re-verify before answering. */
export async function liveRefresh(
  storage: Storage,
  ctx: VerificationContext,
  client: CompaniesHouseClient,
  cfg: CompaniesHouseConfig,
  number: string,
): Promise<boolean> {
  const run = await storage.runs.start({ kind: "live_refresh" });
  const bundle = await fetchCompanyBundle(client, number, cfg);
  if (!bundle.profile) {
    await storage.runs.finish(run.run_id, "failed");
    return false;
  }
  const { claims } = await mapCompanyBundle(bundle, run.run_id, cfg);
  await ingestClaims(storage, ctx, { run_id: run.run_id, fetched_at: bundle.fetched_at }, claims);
  await storage.runs.finish(run.run_id, "succeeded");
  return true;
}

/** Wraps a facilitator so payments are refused while the kill switch is on (guardrail 7). */
export function guardedFacilitator(
  inner: X402Facilitator,
  allowed: () => Promise<boolean>,
): X402Facilitator {
  return {
    dryRun: inner.dryRun,
    async verify(p, r) {
      if (!(await allowed())) return { isValid: false, invalidReason: "service_paused" };
      return inner.verify(p, r);
    },
    async settle(p, r) {
      if (!(await allowed()))
        return {
          success: false,
          errorReason: "service_paused",
          transaction: "",
          network: r.network,
        };
      return inner.settle(p, r);
    },
  };
}
