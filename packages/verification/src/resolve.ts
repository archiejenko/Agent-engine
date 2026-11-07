import type { VerificationConfig } from "@ae/config";
import { CompanyNumber } from "@ae/contracts";
import type { EntityRow, Storage } from "@ae/storage";

/**
 * Entity resolution: anchor a record from any source to a Companies House number.
 * Exact company number → match. Otherwise score normalised name + postcode + web domain:
 * high → auto-match, middle → adjudication (Phase 2: an LLM shown both records, reasoning stored as
 * evidence), low → quarantine.
 */

const SUFFIXES = [
  "LIMITED LIABILITY PARTNERSHIP",
  "PUBLIC LIMITED COMPANY",
  "COMMUNITY INTEREST COMPANY",
  "LIMITED",
  "LTD",
  "PLC",
  "LLP",
  "CIC",
  "CO",
  "COMPANY",
];

export function normaliseName(name: string): string {
  let n = name
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (n.startsWith("THE ")) n = n.slice(4);
  let changed = true;
  while (changed) {
    changed = false;
    for (const s of SUFFIXES) {
      if (n.endsWith(` ${s}`)) {
        n = n.slice(0, -(s.length + 1)).trim();
        changed = true;
      }
    }
  }
  return n;
}

const UK_POSTCODE = /^([A-Z]{1,2}\d[A-Z\d]?) ?(\d[A-Z]{2})$/;

/** "m1 1aa" → "M1 1AA"; returns null if it isn't a UK postcode. */
export function normalisePostcode(pc: string | null | undefined): string | null {
  if (!pc) return null;
  const m = pc
    .toUpperCase()
    .replace(/\s+/g, "")
    .match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
  return m ? `${m[1]} ${m[2]}` : null;
}

export function outwardCode(pc: string): string {
  return pc.match(UK_POSTCODE)?.[1] ?? pc.split(" ")[0] ?? pc;
}

/** Registrable domain from a URL or email ("https://www.acme.co.uk/x" → "acme.co.uk"). */
export function domainOf(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  if (host.includes("@")) host = host.split("@").pop() ?? "";
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0] ?? "";
  host = host.replace(/^www\./, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

/** Name similarity 0–1 (trigram Dice coefficient on normalised names). */
export function nameSimilarity(a: string, b: string): number {
  const x = normaliseName(a);
  const y = normaliseName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const A = trigrams(x);
  const B = trigrams(y);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

export interface RecordToResolve {
  company_number?: string | null;
  name: string;
  postcode?: string | null;
  domain?: string | null;
}

export interface Candidate {
  entity: EntityRow;
  domain?: string | null;
}

export interface MatchScore {
  entity_id: string;
  score: number;
  parts: { name: number; postcode: number | null; domain: number | null };
}

export function scoreCandidate(
  rec: RecordToResolve,
  cand: Candidate,
  weights: VerificationConfig["resolution"]["weights"],
): MatchScore {
  const name = nameSimilarity(rec.name, cand.entity.name);
  const pcA = normalisePostcode(rec.postcode);
  const pcB = normalisePostcode(cand.entity.postcode);
  const postcode =
    pcA && pcB ? (pcA === pcB ? 1 : outwardCode(pcA) === outwardCode(pcB) ? 0.5 : 0) : null;
  const dA = domainOf(rec.domain);
  const dB = domainOf(cand.domain);
  const domain = dA && dB ? (dA === dB ? 1 : 0) : null;
  // Only signals present on both sides count; weights are renormalised over those.
  let total = weights.name * name;
  let weight = weights.name;
  if (postcode !== null) {
    total += weights.postcode * postcode;
    weight += weights.postcode;
  }
  if (domain !== null) {
    total += weights.domain * domain;
    weight += weights.domain;
  }
  return {
    entity_id: cand.entity.entity_id,
    score: weight ? total / weight : 0,
    parts: { name, postcode, domain },
  };
}

export type Resolution =
  | { outcome: "matched"; entity_id: string; score: number; method: "company_number" | "score" }
  | { outcome: "adjudicate"; candidates: MatchScore[] }
  | { outcome: "quarantine"; reason: string; candidates: MatchScore[] };

/** Phase 2 plugs an LLM adjudicator in here; until then the middle band is quarantined for review. */
export interface Adjudicator {
  adjudicate(
    rec: RecordToResolve,
    candidates: MatchScore[],
  ): Promise<{ entity_id: string | null; reasoning: string }>;
}

export async function resolveEntity(
  storage: Storage,
  rec: RecordToResolve,
  cfg: VerificationConfig["resolution"],
  adjudicator?: Adjudicator,
): Promise<Resolution> {
  const num = rec.company_number?.toUpperCase().trim();
  if (num && CompanyNumber.safeParse(num).success && (await storage.entities.get(num))) {
    return { outcome: "matched", entity_id: num, score: 1, method: "company_number" };
  }
  const pool = new Map<string, EntityRow>();
  for (const e of await storage.entities.findCandidates({
    nameNormalised: normaliseName(rec.name),
    postcode: normalisePostcode(rec.postcode) ?? undefined,
    limit: 50,
  })) {
    pool.set(e.entity_id, e);
  }
  const scored = [...pool.values()]
    .map((entity) => scoreCandidate(rec, { entity }, cfg.weights))
    .sort((a, b) => b.score - a.score || a.entity_id.localeCompare(b.entity_id));
  const best = scored[0];
  if (!best) return { outcome: "quarantine", reason: "no candidates", candidates: [] };
  const second = scored[1];
  const ambiguous = second !== undefined && best.score - second.score < 0.05;
  if (best.score >= cfg.auto_match && !ambiguous) {
    return { outcome: "matched", entity_id: best.entity_id, score: best.score, method: "score" };
  }
  if (best.score >= cfg.adjudicate) {
    const top = scored.slice(0, 5);
    if (!adjudicator) return { outcome: "adjudicate", candidates: top };
    const verdict = await adjudicator.adjudicate(rec, top);
    if (verdict.entity_id && top.some((c) => c.entity_id === verdict.entity_id)) {
      return {
        outcome: "matched",
        entity_id: verdict.entity_id,
        score: best.score,
        method: "score",
      };
    }
    return { outcome: "quarantine", reason: `adjudicator: ${verdict.reasoning}`, candidates: top };
  }
  return {
    outcome: "quarantine",
    reason: `best score ${best.score.toFixed(2)} below ${cfg.adjudicate}`,
    candidates: scored.slice(0, 5),
  };
}
