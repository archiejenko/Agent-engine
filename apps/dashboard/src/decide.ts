/**
 * The dashboard's only way to record Archie's choice (rule 18): every button resolves a decision through
 * POST /api/decisions/:id/decide. For something Archie starts himself (raise a tier, promote, pin or
 * kill a Board tile, record a pool top-up), the API first opens the decision (POST
 * /api/decisions/request, which approves nothing), then the same /decide call records the choice.
 */
export type DecisionRequest =
  | { kind: "spend_tier"; playbook: string; tier: "S1" | "S2" | "S3" }
  | { kind: "autonomy"; playbook: string }
  | { kind: "board"; key: string; action: "pin" | "kill" | "unpin" }
  | { kind: "pool_topup"; amount_gbp: number; note?: string };

const errorOf = async (r: Response) =>
  ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`;

/** Decides an open decision. Returns null when done, or the reason it wasn't. */
export async function decideDecision(
  id: string,
  option: string,
  extra: { reason?: string; edited_text?: string; exclude?: string[] } = {},
): Promise<string | null> {
  const r = await fetch(`/api/decisions/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ option, ...extra }),
  });
  return r.ok ? null : errorOf(r);
}

/** Opens a decision for Archie's own request, then decides it with the option he chose. */
export async function requestThenDecide(req: DecisionRequest): Promise<string | null> {
  const r = await fetch("/api/decisions/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!r.ok) return errorOf(r);
  const { decision_id, option } = (await r.json()) as { decision_id: string; option: string };
  return decideDecision(decision_id, option);
}
