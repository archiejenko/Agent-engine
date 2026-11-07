import type { Opportunity } from "@ae/contracts";
import type { ModelClient, ModelRequest } from "@ae/ports";

/**
 * Plain-English rationale for an opportunity, written from the TRACE ONLY. The model may not add
 * claims: every [fact id] it cites must be in the trace, and every number it writes must be a value
 * from the trace. If the check fails, a deterministic template is used instead (never silently).
 */
export const EXPLAIN = {
  id: "opportunity_explain",
  version: 1,
  system: `Write a two-sentence plain-English reason why this company is a lead, for a UK small-business owner.
Use ONLY the signals given. Cite each fact you rely on as [fact id]. Don't add facts, numbers or opinions not in the input.`,
};

export function templateRationale(o: Opportunity): string {
  const top = [...o.trace]
    .filter((t) => t.raw_value !== null)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);
  if (!top.length)
    return "Scored on neutral signals only (little is known about this company yet).";
  return `Top reasons: ${top.map((t) => `${t.signal_id.replace(/_/g, " ")} = ${fmt(t.raw_value as number)}${t.fact_ids[0] ? ` [${t.fact_ids[0]}]` : ""}`).join("; ")}.`;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export function checkRationale(text: string, o: Opportunity): string[] {
  const problems: string[] = [];
  const allowedIds = new Set(o.trace.flatMap((t) => t.fact_ids));
  for (const m of text.matchAll(/\[([^\]]+)\]/g))
    if (!allowedIds.has(m[1] as string)) problems.push(`cites unknown fact ${m[1]}`);
  const allowedNumbers = new Set(
    o.trace.flatMap((t) => (t.raw_value === null ? [] : [fmt(t.raw_value), String(t.raw_value)])),
  );
  let withoutIds = text.replace(/\[[^\]]+\]/g, "");
  // Signal names may contain digits ("director change 90d"); they aren't claims.
  for (const t of o.trace) {
    withoutIds = withoutIds.split(t.signal_id).join(" ").split(t.signal_id.replace(/_/g, " ")).join(" ");
  }
  for (const m of withoutIds.matchAll(/\d+(?:\.\d+)?/g))
    if (!allowedNumbers.has(m[0])) problems.push(`number ${m[0]} not in trace`);
  return problems;
}

export async function explainOpportunity(model: ModelClient, o: Opportunity) {
  const req: ModelRequest = {
    prompt_id: EXPLAIN.id,
    prompt_version: EXPLAIN.version,
    role: "explainer",
    system: EXPLAIN.system,
    user: JSON.stringify({ module: o.module, score: Number(o.score.toFixed(3)), signals: o.trace }),
    max_tokens: 400,
  };
  const res = await model.complete(req);
  const problems = checkRationale(res.text, o);
  return {
    rationale: problems.length ? templateRationale(o) : res.text,
    used_model: problems.length === 0,
    problems,
    usage: res.usage,
    model: res.model,
  };
}

/** Deterministic fake explainer: what a careful model would say, from the trace. */
export function fakeExplainer(req: ModelRequest): string {
  const { signals } = JSON.parse(req.user) as { signals: Opportunity["trace"] };
  const top = signals
    .filter((t) => t.raw_value !== null)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 2);
  if (!top.length) return "Little is known about this company yet.";
  return `This company stands out on ${top.map((t) => `${t.signal_id.replace(/_/g, " ")} (${fmt(t.raw_value as number)})${t.fact_ids[0] ? ` [${t.fact_ids[0]}]` : ""}`).join(" and ")}. These are the strongest signals in its score.`;
}
