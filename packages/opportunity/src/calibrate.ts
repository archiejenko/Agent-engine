import { type InfraConfig, loadInfraConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import {
  type Framework,
  parseFramework,
  renderFrontMatter,
  splitFrontMatter,
} from "./framework.ts";

/**
 * Weight recalibration (Phase 3). When outcome windows close, propose new weights from evidence and
 * write them into the framework note as a clearly marked SUGGESTED change. Weights never change
 * silently: only `acceptSuggestion` edits the front matter. Optimises revenue (GBP), not event counts:
 * positives are weighted by the deal value they produced.
 */
export interface Suggestion {
  id: string;
  current: Record<string, number>;
  suggested: Record<string, number>;
  evidence: {
    closed: number;
    positives: number;
    revenue_gbp: number;
    per_signal: Record<string, { mean_positive: number; mean_negative: number; lift: number }>;
  };
}

function roundToOne(weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights).sort();
  const total = keys.reduce((a, k) => a + (weights[k] as number), 0) || 1;
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = Math.round(((weights[k] as number) / total) * 100) / 100;
  const diff = Math.round((1 - keys.reduce((a, k) => a + (out[k] as number), 0)) * 100) / 100;
  const biggest = keys.reduce(
    (a, k) => ((out[k] as number) > (out[a] as number) ? k : a),
    keys[0] as string,
  );
  out[biggest] = Math.round(((out[biggest] as number) + diff) * 100) / 100;
  return out;
}

export async function suggestWeights(
  storage: Storage,
  fw: Framework,
  now = new Date(),
  cfg: InfraConfig = loadInfraConfig(),
): Promise<Suggestion | null> {
  const window = fw.config.outcome.window_days * 86_400_000;
  const actioned = (
    await storage.opportunities.list({
      module: fw.config.module,
      status: "actioned",
      limit: 100_000,
    })
  ).filter(
    (o) =>
      Date.parse(o.as_of.length === 10 ? `${o.as_of}T23:59:59Z` : o.as_of) + window <=
      now.getTime(),
  );
  if (actioned.length < cfg.modules.calibration_min_closed) return null;
  const outcomeValue = new Map<string, number>();
  for (const o of actioned) {
    const oc = (await storage.outcomes.forOpportunity(o.opportunity_id)).filter(
      (x) => x.event === fw.config.outcome.event && x.value_bool !== false,
    );
    if (oc.length) outcomeValue.set(o.opportunity_id, Math.max(...oc.map((x) => x.value_gbp ?? 1)));
  }
  const positives = actioned.filter((o) => outcomeValue.has(o.opportunity_id));
  if (positives.length < cfg.modules.calibration_min_positives) return null;
  const negatives = actioned.filter((o) => !outcomeValue.has(o.opportunity_id));
  const per: Suggestion["evidence"]["per_signal"] = {};
  const dataWeights: Record<string, number> = {};
  for (const s of Object.keys(fw.config.signals)) {
    const norm = (o: (typeof actioned)[0]) =>
      o.trace.find((t) => t.signal_id === s)?.normalised ?? 0.5;
    const totalValue = positives.reduce(
      (a, o) => a + (outcomeValue.get(o.opportunity_id) as number),
      0,
    );
    const meanPos =
      positives.reduce((a, o) => a + norm(o) * (outcomeValue.get(o.opportunity_id) as number), 0) /
      totalValue;
    const meanNeg = negatives.length
      ? negatives.reduce((a, o) => a + norm(o), 0) / negatives.length
      : 0.5;
    per[s] = { mean_positive: meanPos, mean_negative: meanNeg, lift: meanPos - meanNeg };
    dataWeights[s] = Math.max(0, meanPos - meanNeg);
  }
  const current = Object.fromEntries(
    Object.entries(fw.config.signals).map(([k, v]) => [k, v.weight]),
  );
  const dataTotal = Object.values(dataWeights).reduce((a, b) => a + b, 0);
  if (dataTotal === 0) return null;
  const blend = cfg.modules.calibration_blend;
  const blended = Object.fromEntries(
    Object.keys(current).map((k) => [
      k,
      (1 - blend) * (current[k] as number) + blend * ((dataWeights[k] as number) / dataTotal),
    ]),
  );
  return {
    id: crypto.randomUUID(),
    current,
    suggested: roundToOne(blended),
    evidence: {
      closed: actioned.length,
      positives: positives.length,
      revenue_gbp: positives.reduce(
        (a, o) => a + (outcomeValue.get(o.opportunity_id) as number),
        0,
      ),
      per_signal: per,
    },
  };
}

const MARK = (id: string) => `<!-- ae:suggestion ${id} -->`;

/** Append the suggestion to the note (body only; front matter untouched). Returns the new note text. */
export async function writeSuggestion(
  storage: Storage,
  note: string,
  fw: Framework,
  s: Suggestion,
): Promise<string> {
  await storage.suggestions.add({
    id: s.id,
    module: fw.config.module,
    module_version: fw.config.version,
    current_weights: s.current,
    suggested_weights: s.suggested,
    evidence: s.evidence,
  });
  const rows = Object.keys(s.current)
    .sort()
    .map((k) => {
      const e = s.evidence.per_signal[k];
      return `| ${k} | ${(s.current[k] as number).toFixed(2)} | **${(s.suggested[k] as number).toFixed(2)}** | ${e ? e.lift.toFixed(3) : "–"} |`;
    });
  return `${note.trimEnd()}

## Suggested weight change (PENDING — not applied) ${MARK(s.id)}

Generated ${new Date().toISOString().slice(0, 10)} from ${s.evidence.closed} leads whose ${fw.config.outcome.window_days}-day outcome
window has closed: ${s.evidence.positives} positive, £${s.evidence.revenue_gbp.toFixed(0)} of deal value. Suggested weights blend
the current ones with the evidence (revenue-weighted). Nothing changes until you accept.

| Signal | Current | Suggested | Evidence (revenue-weighted lift) |
|---|---|---|---|
${rows.join("\n")}

To accept: \`pnpm weights accept ${s.id}\` · to reject: \`pnpm weights reject ${s.id}\`
`;
}

/** Accept: apply suggested weights, bump the version, mark the block accepted. */
export async function acceptSuggestion(
  storage: Storage,
  note: string,
  id: string,
): Promise<string> {
  const s = await storage.suggestions.get(id);
  if (s?.status !== "pending") throw new Error(`suggestion ${id} isn't pending`);
  const fw = await parseFramework(note);
  if (fw.config.version !== s.module_version)
    throw new Error("the note has changed version since this suggestion was made");
  const { body } = splitFrontMatter(note);
  const config = structuredClone(fw.config) as unknown as Record<string, unknown> & {
    signals: Record<string, { weight: number }>;
    version: number;
  };
  for (const [k, w] of Object.entries(s.suggested_weights))
    if (config.signals[k]) config.signals[k].weight = w;
  config.version += 1;
  const updated = `${renderFrontMatter(config)}${body.replace(`(PENDING — not applied) ${MARK(id)}`, `(ACCEPTED ${new Date().toISOString().slice(0, 10)}, now v${config.version}) ${MARK(id)}`)}`;
  await parseFramework(updated); // must still be valid
  await storage.suggestions.decide(id, "accepted");
  return updated;
}

export async function rejectSuggestion(
  storage: Storage,
  note: string,
  id: string,
): Promise<string> {
  const s = await storage.suggestions.get(id);
  if (s?.status !== "pending") throw new Error(`suggestion ${id} isn't pending`);
  await storage.suggestions.decide(id, "rejected");
  return note.replace(
    `(PENDING — not applied) ${MARK(id)}`,
    `(REJECTED ${new Date().toISOString().slice(0, 10)}) ${MARK(id)}`,
  );
}
