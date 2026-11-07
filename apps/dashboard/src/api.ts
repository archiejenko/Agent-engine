export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body as T;
}

export interface Fact {
  entity_id: string;
  field: string;
  value: unknown;
  confidence: number;
  supporting_claims: string[];
  conflicting_claims: string[];
  lane: string;
  valid_from: string;
  first_observed_at: string;
  last_verified_at: string;
  expires_at: string | null;
  status: string;
}

export interface Claim {
  claim_id: string;
  field: string;
  value: unknown;
  source: string;
  source_tier: number;
  method: string;
  evidence: { kind: string; ref: string; text?: string } | null;
  observed_at: string;
  published_at: string;
  fetched_at: string;
  run_id: string;
}

export const short = (v: unknown, max = 120): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};
export const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");
