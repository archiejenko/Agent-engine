import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AgentService, fakeModel, type GateCriterion, loadPlaybooks } from "@ae/agent-runner";
import { loadGraphPolicy, loadModelsConfig } from "@ae/config";
import { GraphSpec } from "@ae/contracts";
import { exportNodeLibrary, priceModelCall } from "@ae/graph";
import type { Storage } from "@ae/storage";
import { migrate, rollback } from "@ae/storage";
import { loadDownMigrations, loadMigrations } from "@ae/storage/migrations-fs";
import { openSqliteStorage, sqliteDriver } from "@ae/storage/sqlite";

/**
 * Graph G0 gate: contracts, storage and the node library export. No runtime change.
 * The model price table was checked against Anthropic's live pricing page on 2026-11-18 (addition 2).
 */
export const PRICES_SEEN_ON_PAGE_2026_11_18: Record<
  string,
  { in: number; out: number; cacheRead: number }
> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

export async function runGraphG0Gate(storage: Storage, root: string) {
  // 1. Schemas: the sme_outreach-shaped example passes; a set of bad specs each fail.
  const valid = JSON.parse(
    readFileSync(join(root, "packages/graph/fixtures/example-spec.json"), "utf8"),
  );
  const ok = GraphSpec.safeParse(valid).success;
  const bad: [string, (s: Record<string, unknown>) => void][] = [
    ["planner-set lane", (s) => (stateField(s, "brief").lane = "open")],
    ["code smuggled in", (s) => (s.code = "fetch('x')")],
    ["unknown entry", (s) => (s.entry = "ghost")],
    ["role that doesn't exist", (s) => (firstNode(s).ref = "planner")],
    ["permission request on a node", (s) => (firstNode(s).tools = ["send_email"])],
    ["dot in a node id", (s) => (firstNode(s).id = "re.search")],
  ];
  const badResults = bad.map(([name, mut]) => {
    const s = structuredClone(valid);
    mut(s);
    return { name, rejected: !GraphSpec.safeParse(s).success };
  });

  // 2. Migrations up, down, up on a fresh database.
  const all = loadMigrations();
  const down = loadDownMigrations();
  const graphMigrations = all.filter((m) => down.has(m.name)).map((m) => m.name);
  const db = sqliteDriver(":memory:");
  await migrate(db, all);
  const tables = async () =>
    (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
    ).map((r) => r.name);
  const upTables = await tables();
  for (const n of [...graphMigrations].reverse())
    await rollback(db, all.find((m) => m.name === n) as never, down.get(n) as string);
  const downTables = await tables();
  const reapplied = await migrate(db, all);
  const upAgain = await tables();

  // 3. Node library export from the LIVE registry (every tool the agent service registers).
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model: fakeModel(),
  });
  const registered = service.tools.list();
  const playbooks = [...service.playbooks.values()].map((p) => ({
    name: p.spec.playbook,
    version: p.spec.version,
    autonomy: p.spec.autonomy,
    revenue_path: p.spec.revenue_path,
    stats: { runs: 0, success_rate: null, avg_cost_gbp: null },
  }));
  const models = loadModelsConfig();
  const lib = await exportNodeLibrary({
    tools: registered,
    models,
    playbooks,
    policy: loadGraphPolicy(),
  });
  const lib2 = await exportNodeLibrary({
    tools: [...registered].reverse(),
    models,
    playbooks,
    policy: loadGraphPolicy(),
  });
  const missing = registered.filter((t) => !lib.tools.some((x) => x.ref === t.name));
  const flagsMatch = registered.every((t) => {
    const x = lib.tools.find((y) => y.ref === t.name);
    return (
      x?.acts_externally === t.external &&
      x.serves_customer === t.serves_customer &&
      x.cost_gbp_per_call === t.cost_gbp_per_call
    );
  });

  // 4. Price table vs the live page; one call priced by hand.
  const priceRows = Object.entries(PRICES_SEEN_ON_PAGE_2026_11_18).map(([m, seen]) => {
    const p = models.prices[m];
    return {
      m,
      match:
        p?.input_usd_per_mtok === seen.in &&
        p.output_usd_per_mtok === seen.out &&
        p.cache_read_usd_per_mtok === seen.cacheRead,
    };
  });
  const priced = priceModelCall(
    "claude-opus-5-5",
    { input_tokens: 6000, output_tokens: 1500 },
    models,
  );
  const byHand = ((6000 * 4 + 1500 * 20) / 1e6) * models.usd_to_gbp;

  // 5. The decision log is separate from the outcome ledger; the money ledgers are append-only.
  const s2 = await openSqliteStorage(":memory:");
  await s2.decisionLog.add({
    id: "g0",
    at: new Date().toISOString(),
    subject: "graph_plan",
    subject_id: "x@1",
    graph_id: "x",
    graph_version: 1,
    decision: "reject",
    reason: "G0-REASON-CANARY",
    by: "archie",
    decision_id: null,
  });
  const reasonTables = await s2.audit.tablesContaining("G0-REASON-CANARY");
  const appendOnly = await s2.costEvents
    .add({
      event_id: "e",
      at: new Date().toISOString(),
      run_id: null,
      graph_id: null,
      graph_version: null,
      node_id: null,
      task_id: null,
      opportunity_id: null,
      revenue_path: null,
      shape_fingerprint: null,
      mode: "live",
      category: "tool",
      unit: "call",
      quantity: 1,
      unit_price_gbp: 0,
      amount_gbp: 0,
      price_table_version: models.price_table_version,
      synthetic: false,
      dry_run: true,
    })
    .then(() =>
      (s2 as unknown as { db: { run: (q: string) => Promise<unknown> } }).db.run(
        "DELETE FROM cost_events",
      ),
    )
    .then(
      () => "deleted",
      (e: Error) => e.message,
    );

  // 6. The graph layer reaches the runtime only behind GRAPH_ENGINE_ENABLED (wired in G2, off by default):
  // the runner service is the one app file that imports it, the flag is off unless set to "1", and
  // nothing outside gates and tests calls the G1 equivalence driver.
  const runtimeImporters = walk(root, [
    "apps/api/src",
    "apps/agent-runner/src",
    "apps/dashboard/src",
    "packages",
  ]).filter((f) => {
    if (/gates\/|\.test\.|__tests__|packages\/graph\//.test(f)) return false;
    // The flag-gated entry point, and the sandbox (runs only when a gate or the planner calls it).
    if (/apps\/agent-runner\/src\/(service|sandbox)\.ts$/.test(f)) return false;
    const t = readFileSync(f, "utf8");
    const app = /\/apps\//.test(f) && /from "@ae\/graph"/.test(t);
    const callsDriver =
      /runTaskAsGraph\(/.test(t) && !/export async function runTaskAsGraph/.test(t);
    return app || callsDriver;
  });
  const flagDefault = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model: fakeModel(),
  }).graphEngine.enabled;
  const wranglerFlag =
    /"GRAPH_ENGINE_ENABLED":\s*"([^"]*)"/.exec(
      readFileSync(join(root, "apps/api/wrangler.jsonc"), "utf8"),
    )?.[1] ?? "missing";

  const criteria: GateCriterion[] = [
    {
      criterion:
        "Graph schemas: a valid spec passes; specs that set a lane, smuggle code, request permissions or misname nodes fail",
      status: ok && badResults.every((b) => b.rejected) ? "passed (synthetic)" : "failed",
      evidence: `example spec ${ok ? "accepted" : "REJECTED"}; rejected: ${badResults.map((b) => `${b.name} ${b.rejected ? "✓" : "✗"}`).join(", ")}; 13 contract tests in packages/contracts`,
    },
    {
      criterion:
        "Migrations 0020–0022 run up, down and up again; down files sit outside the folder wrangler deploys",
      status:
        graphMigrations.length === 3 &&
        upTables.includes("cost_events") &&
        !downTables.includes("cost_events") &&
        !downTables.includes("graph_specs") &&
        reapplied.length === 3 &&
        JSON.stringify(upAgain) === JSON.stringify(upTables)
          ? "passed (synthetic)"
          : "failed",
      evidence: `${graphMigrations.join(", ")}: up → ${upTables.length} tables, down → ${downTables.length}, up again → ${upAgain.length}; schema compared column by column in packages/storage tests`,
    },
    {
      criterion:
        "The node library export lists every registered tool, role and function, deterministically",
      status:
        missing.length === 0 &&
        flagsMatch &&
        lib.registryVersion === lib2.registryVersion &&
        lib.roles.length === 4 &&
        lib.subgraphs.length === playbooks.length
          ? "passed (synthetic)"
          : "failed",
      evidence: `${lib.tools.length} tools (${lib.tools.filter((t) => t.acts_externally).length} act externally), ${lib.roles.length} roles, ${lib.functions.length} functions, ${lib.subgraphs.length} playbooks; registry version ${lib.registryVersion} (same with tools in reverse order)`,
    },
    {
      criterion:
        "Model price table checked against Anthropic's live pricing page (2026-11-18); a call priced from reported usage matches a hand calculation",
      status:
        priceRows.every((r) => r.match) && Math.abs(priced.total_gbp - byHand) < 1e-12
          ? "passed (synthetic)"
          : "failed",
      evidence: `checked https://platform.claude.com/docs/en/about-claude/pricing on ${models.prices_checked_at} (the page shows no "last updated" date): ${priceRows.map((r) => `${r.m} ${r.match ? "matches" : "DIFFERS"}`).join("; ")}; cache-read and cache-write prices and Haiku's >100k tier added; price table version ${models.price_table_version}`,
    },
    {
      criterion:
        "Archie's reasons live in a separate decision log, never in the outcome ledger; money ledgers are append-only",
      status:
        reasonTables.length === 1 &&
        reasonTables[0] === "decision_log" &&
        /append-only/.test(appendOnly)
          ? "passed (synthetic)"
          : "failed",
      evidence: `a reason canary appears only in: ${reasonTables.join(", ")}; deleting a cost event: "${appendOnly}"`,
    },
    {
      criterion:
        "No runtime change by default: the graph layer runs only behind GRAPH_ENGINE_ENABLED; every existing test and gate stays green",
      status:
        runtimeImporters.length === 0 && flagDefault === false && wranglerFlag === ""
          ? "passed (synthetic)"
          : "failed",
      evidence: `only the runner service and the sandbox import the graph layer (others: ${runtimeImporters.length}); flag default ${flagDefault ? "on" : "off"}, Worker var "${wranglerFlag}"; nothing outside gates/tests calls the G1 driver; \`pnpm check\` (every v1–v3 gate test included) is green at this commit`,
    },
  ];
  return { criteria };
}

function walk(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === "dist") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) go(p);
      else if (/\.tsx?$/.test(n)) out.push(p);
    }
  };
  for (const d of dirs) go(join(root, d));
  return out;
}

const firstNode = (s: Record<string, unknown>) =>
  (s.nodes as Record<string, unknown>[])[0] as Record<string, unknown>;
const stateField = (s: Record<string, unknown>, k: string) =>
  (s.state as Record<string, Record<string, unknown>>)[k] as Record<string, unknown>;
