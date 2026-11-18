import type { Storage } from "@ae/storage";

/**
 * Stage 5 review (cutover, docs/live-cutover.md): a read-only summary of the latest REAL drafts (written
 * by the real model, not the fake, and not simulator rows), so Archie can judge them in one place.
 * - checker pass rate first time, and which copy rule rejected what;
 * - cost per draft (model and tool cost, not print/postage);
 * - Archie's edit rate on approved drafts;
 * - phrases repeated across drafts (the checker doesn't catch repetition).
 * Aggregates only: no arm, cohort or holdout detail (rule 22). Everything is computed in code.
 */
export const DRAFT_PLAYBOOKS = ["sme_outreach", "sme_letter"] as const;

export interface Stage5Review {
  drafts: number;
  by_playbook: Record<string, number>;
  models: Record<string, string[]>;
  first_time_pass_rate: number | null;
  passed_after_retry: number;
  failed_twice: number;
  rejection_reasons: { reason: string; count: number }[];
  cost_per_draft_gbp: { mean: number | null; max: number | null };
  decisions: { approved: number; edited: number; rejected: number; waiting: number };
  edit_rate: number | null;
  repeated_phrases: { phrase: string; drafts: number; everywhere: boolean }[];
  task_ids: string[];
}

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9£' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Shingles of `n` words; a phrase counts once per draft. */
export function repeatedPhrases(texts: string[], n = 4, minDrafts = 3) {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const w = words(t);
    const seen = new Set<string>();
    for (let i = 0; i + n <= w.length; i++) seen.add(w.slice(i, i + n).join(" "));
    for (const s of seen) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minDrafts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phrase, c]) => ({ phrase, drafts: c, everywhere: c === texts.length }));
}

/** "company name used 3 times (max 2)" → "company name used N times": groups the same rule. */
const ruleOf = (reason: string) =>
  reason
    .replace(/\(.*?\)/g, "")
    .replace(/\d+/g, "N")
    .replace(/"[^"]*"/g, (m) => m)
    .trim();

export async function stage5Review(
  storage: Storage,
  o: { limit?: number } = {},
): Promise<Stage5Review> {
  const limit = o.limit ?? 20;
  const picked: {
    task_id: string;
    playbook: string;
    state: unknown;
    cost: number;
    models: Set<string>;
  }[] = [];
  const models: Record<string, Set<string>> = {};
  let passFirst = 0;
  let afterRetry = 0;
  let failedTwice = 0;
  let checked = 0;
  const reasons = new Map<string, number>();
  for (const pb of DRAFT_PLAYBOOKS) {
    const tasks = (await storage.tasks.list({ playbook: pb, limit: 500 })).filter(
      (t) => !(t as { synthetic?: boolean }).synthetic,
    );
    for (const t of tasks) {
      if (picked.filter((p) => p.playbook === pb).length >= limit) break;
      const log = await storage.runLog.forTask(t.task_id);
      const writer = log.filter((l) => l.role === "writer" && l.model);
      // Real drafts only: written by a real model.
      if (writer.length === 0 || writer.every((l) => l.model === "fake-model")) continue;
      for (const l of log)
        if (l.model && l.model !== "fake-model") {
          const set = models[l.role] ?? new Set<string>();
          set.add(l.model);
          models[l.role] = set;
        }
      const checks = log.filter((l) => l.check_result);
      if (checks.length) {
        checked++;
        const results = checks.map(
          (c) => (c.check_result as { passed: boolean; reasons: string[] }) ?? null,
        );
        if (results[0]?.passed) passFirst++;
        else if (results.some((r) => r?.passed)) afterRetry++;
        else failedTwice++;
        for (const r of results)
          for (const reason of r?.reasons ?? [])
            reasons.set(ruleOf(reason), (reasons.get(ruleOf(reason)) ?? 0) + 1);
      }
      const draftCost = log
        .filter((l) => l.role !== "operator")
        .reduce((a, l) => a + l.cost_gbp, 0);
      picked.push({
        task_id: t.task_id,
        playbook: pb,
        state: t.state,
        cost: draftCost,
        models: new Set(),
      });
    }
  }
  const decisions = { approved: 0, edited: 0, rejected: 0, waiting: 0 };
  const texts: string[] = [];
  for (const p of picked) {
    const a = await storage.approvals.forTask(p.task_id);
    const last = a.at(-1);
    if (!last) decisions.waiting++;
    else if (last.decision === "approve") decisions.approved++;
    else if (last.decision === "edit") decisions.edited++;
    else decisions.rejected++;
    const outs =
      (p.state as { outputs?: Record<string, { body?: string } | undefined> } | null)?.outputs ??
      {};
    const body = outs.email_draft?.body ?? outs.letter_draft?.body;
    if (body) texts.push(body);
  }
  const costs = picked.map((p) => p.cost);
  const decided = decisions.approved + decisions.edited;
  return {
    drafts: picked.length,
    by_playbook: Object.fromEntries(
      DRAFT_PLAYBOOKS.map((pb) => [pb, picked.filter((p) => p.playbook === pb).length]),
    ),
    models: Object.fromEntries(Object.entries(models).map(([k, v]) => [k, [...v].sort()])),
    first_time_pass_rate: checked ? passFirst / checked : null,
    passed_after_retry: afterRetry,
    failed_twice: failedTwice,
    rejection_reasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    cost_per_draft_gbp: {
      mean: costs.length ? costs.reduce((a, c) => a + c, 0) / costs.length : null,
      max: costs.length ? Math.max(...costs) : null,
    },
    decisions,
    edit_rate: decided ? decisions.edited / decided : null,
    repeated_phrases: repeatedPhrases(texts).slice(0, 15),
    task_ids: picked.map((p) => p.task_id),
  };
}
