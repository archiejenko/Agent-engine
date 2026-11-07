import type { Claim } from "@ae/contracts";
import { canonicalJson, stableUuid } from "../../ids.ts";
import { normalisePostcode } from "../../resolve.ts";

/**
 * ONS postcode → local authority district lookup (ONSPD / NSPL / "PCD to LAD" files all work).
 * Column names differ between releases, so we detect them. Only rows whose LAD is in `keepLads`
 * are kept, which keeps memory small (Greater Manchester ≈ 80k postcodes).
 */
export const ONS_SOURCE = "ons_postcode_directory";
const POSTCODE_COLUMNS = ["pcds", "pcd", "pcd7", "pcd8", "postcode", "pcd2"];
const LAD_PATTERNS = [/^lad\d{2}cd$/, /^oslaua$/, /^laua$/, /^ladcd$/, /^lad_code$/];

export function detectOnsColumns(headers: string[]): { postcode: string; lad: string } {
  const lower = headers.map((h) => h.trim().toLowerCase());
  const postcode = POSTCODE_COLUMNS.find((c) => lower.includes(c));
  // Prefer the newest LADxxCD column if several exist.
  const ladCandidates = lower
    .filter((h) => LAD_PATTERNS.some((p) => p.test(h)))
    .sort()
    .reverse();
  const lad = ladCandidates[0];
  if (!postcode || !lad) {
    throw new Error(
      `Couldn't find postcode/LAD columns in the ONS file (headers: ${headers.slice(0, 12).join(", ")}...)`,
    );
  }
  return {
    postcode: headers[lower.indexOf(postcode)] as string,
    lad: headers[lower.indexOf(lad)] as string,
  };
}

export function addOnsRow(
  map: Map<string, string>,
  row: Record<string, string>,
  cols: { postcode: string; lad: string },
  keepLads: Set<string>,
) {
  const lad = row[cols.lad]?.trim();
  if (!lad || !keepLads.has(lad)) return;
  const pc = normalisePostcode(row[cols.postcode]);
  if (pc) map.set(pc, lad);
}

export async function ladClaim(
  entityId: string,
  name: string,
  postcode: string,
  lad: string,
  releaseDate: string,
  fileName: string,
  runId: string,
  fetchedAt: string,
): Promise<Claim> {
  const published = `${releaseDate}T00:00:00Z`;
  return {
    claim_id: await stableUuid([
      ONS_SOURCE,
      entityId,
      "registered_office_lad",
      published,
      canonicalJson(lad),
    ]),
    entity_id: entityId,
    raw_entity_ref: { source_id: entityId, name },
    field: "registered_office_lad",
    value: lad,
    source: ONS_SOURCE,
    source_tier: 2,
    lane: "open",
    method: "bulk_file",
    evidence: { kind: "record", ref: `${fileName}#${postcode}` },
    observed_at: published,
    published_at: published,
    fetched_at: fetchedAt,
    run_id: runId,
  };
}
