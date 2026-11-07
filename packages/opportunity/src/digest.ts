import type { Storage } from "@ae/storage";
import type { Framework } from "./framework.ts";

/** Weekly digest for a module: brain/digests/YYYY-MM-DD-<module>.md (markdown returned; caller writes). */
export async function moduleDigest(
  storage: Storage,
  fw: Framework,
  now = new Date(),
): Promise<{ path: string; markdown: string }> {
  const day = now.toISOString().slice(0, 10);
  const m = fw.config.module;
  const open = (
    await storage.opportunities.list({ module: m, status: "proposed", limit: 10 })
  ).sort((a, b) => a.rank - b.rank);
  const actioned = await storage.opportunities.list({
    module: m,
    status: "actioned",
    limit: 100_000,
  });
  let positives = 0;
  let revenue = 0;
  for (const o of actioned) {
    const oc = (await storage.outcomes.forOpportunity(o.opportunity_id)).filter(
      (x) => x.event === fw.config.outcome.event && x.value_bool !== false,
    );
    if (oc.length) {
      positives++;
      revenue += Math.max(...oc.map((x) => x.value_gbp ?? 0));
    }
  }
  const bt = await storage.backtests.latest(m);
  const pending = await storage.suggestions.pending(m);
  const status = (await storage.controls.get<string>(`module:status:${m}`)) ?? "pilot";
  const markdown = `---
type: digest
module: ${m}
module_version: ${fw.config.version}
date: ${day}
---

# ${m} — weekly digest (${day})

Status: **${status}** · note v${fw.config.version}

## Top open leads
${open.length ? open.map((o) => `- ${o.entity_id} — score ${o.score.toFixed(2)}, EV £${o.expected_value_gbp.toFixed(0)}${o.explore ? " (exploration)" : ""}${o.rationale ? ` — ${o.rationale}` : ""}`).join("\n") : "- none"}

## Hit rate
- Leads actioned: ${actioned.length}; ${fw.config.outcome.event}: ${positives} (${actioned.length ? ((100 * positives) / actioned.length).toFixed(1) : "0"}%); revenue £${revenue.toFixed(0)}

## Latest backtest
${bt ? `- as of ${bt.as_of} (${bt.mode} mode, ${bt.window_days}-day window): precision@20 ${(bt.precision_at_20 * 100).toFixed(0)}%, base rate ${(bt.base_rate * 100).toFixed(1)}%, lift ${bt.lift.toFixed(2)}×${bt.revenue_lift !== null ? `, revenue lift ${bt.revenue_lift.toFixed(2)}×` : ""}` : "- none yet"}

## Suggested weight changes
${pending.length ? pending.map((id) => `- pending: ${id} (see the framework note)`).join("\n") : "- none pending"}
`;
  return { path: `brain/digests/${day}-${m}.md`, markdown };
}

/** Weekly margin report per playbook: brain/digests/YYYY-MM-DD-margin.md. */
export async function marginReport(
  storage: Storage,
  now = new Date(),
): Promise<{ path: string; markdown: string }> {
  const day = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const rows = await storage.margins(since);
  const markdown = `---
type: digest
report: margin
date: ${day}
---

# Margin report — week to ${day}

| Playbook | Tasks | Done | Cost (£) | Revenue (£) | Margin (£) | Cost per task (£) |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.playbook} | ${r.tasks} | ${r.done} | ${r.cost_gbp.toFixed(4)} | ${r.revenue_gbp.toFixed(2)} | ${r.margin_gbp.toFixed(2)} | ${(r.cost_gbp / Math.max(1, r.tasks)).toFixed(4)} |`).join("\n") || "| (no tasks) | | | | | | |"}
`;
  return { path: `brain/digests/${day}-margin.md`, markdown };
}
