/**
 * Deterministic UUID (version 5 layout, SHA-1 based) from a list of parts. The same source saying
 * the same thing about the same entity at the same published time always gets the same claim_id, so
 * re-running an ingestion records an observation instead of a duplicate claim (reproducibility).
 */
export async function stableUuid(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(`agent-engine:${parts.join("␟")}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(0, 16);
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50; // version 5
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80; // RFC variant
  const hex = [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable JSON: object keys sorted, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
