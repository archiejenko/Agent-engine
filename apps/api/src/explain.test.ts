import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentService, buildSyntheticWorld, fakeModel, loadPlaybooks } from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import { createTask } from "@ae/infra";
import type { SqlDriver } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

/**
 * Data layer plan, step 6: the main dashboard pages' queries use indexes. Each page is requested on a
 * synthetic world; every SELECT it runs is explained against its own database. A full scan of a table
 * that grows with use fails the test. `EXPLAIN_REPORT=<file>` also writes the report.
 */
const PAGES: Record<string, string> = {
  Home: "/api/home",
  "Needs you": "/api/decisions",
  "Budgets / costs": "/api/budgets",
  "Ideas feed": "/api/ideas",
  Board: "/api/board",
  CRM: "/api/crm",
  "CRM company": "/api/crm/:entity",
  Inbox: "/api/inbox",
};
/** Tables that grow with use. Small, bounded tables (controls, board tiles, keys…) may be scanned. */
const GROWING = new Set([
  "tasks",
  "outcomes",
  "outbox",
  "cost_events",
  "revenue_events",
  "decisions",
  "owner_approvals",
  "decision_log",
  "mail_messages",
  "letters",
  "opportunities",
  "claims",
  "claim_observations",
  "verified_facts",
  "verified_fact_versions",
  "run_log",
  "idea_cards",
  "idea_thread",
  "experiments",
  "note_versions",
  "review_sessions",
  "approvals",
  "external_effects",
  "site_claims",
  "scout_signals",
  "daily_rollups",
]);

describe("dashboard queries use indexes (EXPLAIN QUERY PLAN)", () => {
  it("no main dashboard page fully scans a growing table", async () => {
    const storage = await openSqliteStorage(":memory:");
    const model = fakeModel();
    await buildSyntheticWorld(storage, model, { count: 60, seed: 3 });
    const entity = (await storage.facts.listCurrent({ status: "verified", limit: 1, offset: 0 }))
      .rows[0]?.entity_id as string;
    const service = new AgentService({
      storage,
      playbooks: await loadPlaybooks(join(import.meta.dirname, "../../../playbooks")),
      model,
    });
    for (let i = 0; i < 3; i++)
      await createTask(storage, loadInfraConfig(), service.playbooks, service.queue, {
        idempotency_key: `e:${i}`,
        playbook: "sme_outreach",
        revenue_path: "sme_outreach",
        source_ref: `opportunity:e-${i}:entity:${entity}`,
        lane: "open",
      });
    await service.runQueued();
    const stores = (storage.driver as unknown as { stores: Record<string, SqlDriver> }).stores;
    let page = "";
    const seen = new Map<string, { page: string; store: string; sql: string; params: unknown[] }>();
    for (const [store, d] of Object.entries(stores)) {
      const orig = d.all.bind(d);
      (d as { all: SqlDriver["all"] }).all = (sql, params) => {
        if (page && /^\s*(SELECT|WITH)\b/i.test(sql) && !/sqlite_master|d1_migrations/.test(sql))
          seen.set(`${page}|${sql}`, { page, store, sql, params: params ?? [] });
        return orig(sql, params) as never;
      };
    }
    const app = createApp({ runtime: "node", storage: () => storage });
    for (const [name, path] of Object.entries(PAGES)) {
      page = name;
      const res = await app.request(path.replace(":entity", entity));
      expect(res.status, path).toBe(200);
    }
    page = "";
    const report: string[] = [];
    const failures: string[] = [];
    let last = "";
    for (const q of seen.values()) {
      const plan =
        (
          await stores[q.store]?.all<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${q.sql}`,
            q.params as never,
          )
        )?.map((r) => r.detail) ?? [];
      for (const p of plan) {
        const t = p.match(/^SCAN (\w+)(?! USING)/)?.[1];
        const real = q.sql.match(
          new RegExp(`\\b(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${t}\\b`, "i"),
        )?.[1];
        const table = real ?? t;
        if (t && !/USING (COVERING )?INDEX/.test(p) && table && GROWING.has(table))
          failures.push(`${q.page}: ${p} — ${q.sql.replace(/\s+/g, " ").slice(0, 140)}`);
      }
      if (q.page !== last) report.push(`\n## ${q.page} (\`${PAGES[q.page]}\`)\n`);
      last = q.page;
      report.push(
        `- \`${q.sql.replace(/\s+/g, " ").trim().slice(0, 220)}\` (${q.store})`,
        ...plan.map((p) => `  - ${p}`),
      );
    }
    if (process.env.EXPLAIN_REPORT)
      writeFileSync(process.env.EXPLAIN_REPORT, `${report.join("\n")}\n`);
    expect(failures).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  });
});
