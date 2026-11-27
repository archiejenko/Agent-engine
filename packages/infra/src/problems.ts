import { loadIdeaCategoriesConfig, loadIndustriesConfig } from "@ae/config";
import type { IndustriesConfig, Problem } from "@ae/contracts";
import type { Storage } from "@ae/storage";

/**
 * v4 Phase 1: seed the problem map from the idea backlog (hypotheses). One problem per
 * industry × function × seed category, listing the ideas behind it. Every one is SENSED, with no
 * evidence and strength 0: a seed idea is a guess at a problem, not evidence of one (rule 23). Problems
 * become evidenced only from verified facts and signals (Phase 4 onwards). Idempotent.
 */

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

export async function seedProblemsFromIdeas(
  storage: Storage,
  o: { industries?: IndustriesConfig } = {},
): Promise<{ problems: number; ideas: number }> {
  const industries = o.industries ?? loadIndustriesConfig();
  const cats = loadIdeaCategoriesConfig();
  const hyps = await storage.hypotheses.list({ limit: 100_000 });
  const groups = new Map<string, Problem>();
  for (const h of hyps) {
    const fn = h.function ?? cats.categories[h.category]?.node ?? "unassigned";
    const industry = industries.seed_category_industry[h.category] ?? "all_smes";
    const pslug = slug(h.category);
    const id = `prb_${slug(`${industry}_${fn}_${pslug}`)}`;
    const g = groups.get(id) ?? {
      problem_id: id,
      industry_code: industry,
      function: fn,
      problem_slug: pslug,
      statement: `Seed ideas in "${h.category}" (${fn}). Sensed from the seed list, not yet evidenced.`,
      evidence_fact_ids: [],
      evidence_strength: 0,
      status: "sensed" as const,
      markets_seen: ["UK" as const],
      seed_hypothesis_ids: [],
      source: "brain/ideas/seed-500.csv",
      synthetic: false,
    };
    g.seed_hypothesis_ids.push(h.id);
    if (h.synthetic) g.synthetic = true;
    groups.set(id, g);
  }
  const problems = [...groups.values()].map((p) => ({
    ...p,
    seed_hypothesis_ids: [...p.seed_hypothesis_ids].sort(),
  }));
  await storage.portfolio.problems.putMany(problems);
  return { problems: problems.length, ideas: hyps.length };
}
