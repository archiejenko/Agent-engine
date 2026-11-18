import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadGraphPolicy, loadInfraConfig } from "@ae/config";
import type { CompiledGraph, GraphSpec } from "@ae/contracts";
import {
  baseContext,
  baseSpec,
  CONVERSION_NARROWING,
  compile,
  fixtureLibrary,
  playbookToGraph,
  RULE_FIXTURES,
  RULES,
} from "@ae/graph";
import { createTask, fakeOutreachWriter, runTaskAsGraph } from "@ae/infra";
import type { ModelRequest } from "@ae/ports";
import type { Storage, StoredTask } from "@ae/storage";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { convertedGraphs } from "../../../../scripts/gen-graphs.ts";
import { libraryFor, shapeOf } from "./graph-lib.ts";

/**
 * Graph G1 gate: the compiler (one failing fixture per rule), the dry-run interpreter, and all seven
 * playbooks as graphs. Equivalence: two identical synthetic worlds; world A runs every fixture task on the
 * OLD runner, world B runs the same tasks as converted graphs; run logs, approvals, final statuses and
 * costs must match exactly.
 */
type Scenario = {
  name: string;
  playbook: string;
  entity: number;
  decisions: ("approve" | "edit" | "reject")[];
  state?: (e: string) => Record<string, unknown>;
  ref?: (e: string) => string;
};

const SCENARIOS: Scenario[] = [
  {
    name: "outreach: passes first time, Archie edits",
    playbook: "sme_outreach",
    entity: 0,
    decisions: ["edit"],
  },
  {
    name: "outreach: fails the check once, passes on retry",
    playbook: "sme_outreach",
    entity: 1,
    decisions: ["approve"],
  },
  {
    name: "outreach: fails twice, Archie approves the review",
    playbook: "sme_outreach",
    entity: 2,
    decisions: ["approve"],
  },
  {
    name: "letter: drafted, prepared, print batch approved",
    playbook: "sme_letter",
    entity: 3,
    decisions: ["approve"],
  },
  {
    name: "reply: drafted, Archie rejects",
    playbook: "post_reply",
    entity: 4,
    decisions: ["reject"],
    ref: (e) => `reply:msg-fixture:entity:${e}`,
    state: () => ({
      reply: {
        from: "owner@example.co.uk",
        subject: "Re: your idea",
        body: "Sounds interesting, what would it cost?",
        received_at: "2026-11-18T09:00:00Z",
      },
    }),
  },
  {
    name: "human report (L3, frozen)",
    playbook: "human_report",
    entity: 5,
    decisions: [],
    ref: (e) => `stripe:cs_test_fixture:entity:${e}`,
    state: (e) => ({ company_number: e, email: "buyer@example.co.uk" }),
  },
  {
    name: "monitoring activation (L3, frozen)",
    playbook: "monitoring_subscription",
    entity: 6,
    decisions: [],
    ref: () => "stripe:cs_test_mon",
  },
  {
    name: "watch alert (L3, frozen)",
    playbook: "watch_alert",
    entity: 7,
    decisions: [],
    ref: (e) => `watch:w-fixture:entity:${e}`,
  },
];

/** A writer that fails the copy rules for chosen companies: once for entity #1, always for entity #2. */
function scriptedModel(entities: string[]) {
  const calls = new Map<string, number>();
  const m = fakeModel();
  const original = m.complete.bind(m);
  m.complete = async (req: ModelRequest) => {
    if (req.prompt_id === "sme_outreach_draft") {
      const brief = (JSON.parse(req.user) as { brief: { entity_id: string } }).brief;
      const n = (calls.get(brief.entity_id) ?? 0) + 1;
      calls.set(brief.entity_id, n);
      const failing =
        brief.entity_id === entities[2] || (brief.entity_id === entities[1] && n === 1);
      if (failing) {
        const text = JSON.stringify({
          subject: "Hello",
          body: "I noticed your site. I noticed it again.",
          claims: [],
        });
        return {
          text,
          model: "fake-model",
          usage: {
            input_tokens: Math.ceil(req.user.length / 4),
            output_tokens: Math.ceil(text.length / 4),
          },
          stop_reason: "end_turn",
        };
      }
      void fakeOutreachWriter;
    }
    return original(req);
  };
  return m;
}

async function world(root: string) {
  const storage = await openSqliteStorage(":memory:");
  const base = fakeModel();
  await buildSyntheticWorld(storage, base, { count: 60, seed: 11 });
  const entities = [
    ...new Set(
      (await storage.facts.listCurrent({ status: "verified", limit: 400, offset: 0 })).rows.map(
        (f) => f.entity_id,
      ),
    ),
  ].sort();
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model: scriptedModel(entities),
  });
  const customer = await storage.customers.add({
    id: "cust-fixture",
    name: "Fixture Ltd",
    email: "alerts@example.co.uk",
    plan: "per_alert",
    payment_ref: null,
  });
  const watchId = await storage.watches.add({
    customer_id: customer,
    entity_id: entities[7] as string,
    fields: ["company_status"],
    channel: "email",
    target: "alerts@example.co.uk",
  });
  return { storage, service, entities, watchId };
}

/** Comparable view of a task's records: ids and timestamps replaced, order kept. */
async function recordsOf(storage: Storage, task: StoredTask) {
  const scrub = (v: unknown) =>
    JSON.parse(
      JSON.stringify(v ?? null)
        .replaceAll(task.task_id, "<task>")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
        .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<ts>")
        // Random per letter by design (demo page address, opt-out code).
        .replace(/"(demo_slug|opt_out_code)":"[^"]*"/g, '"$1":"<random>"'),
    );
  const fresh = (await storage.tasks.get(task.task_id)) as StoredTask;
  return {
    status: fresh.status,
    cost_gbp: Math.round(fresh.cost_gbp * 1e9) / 1e9,
    log: (await storage.runLog.forTask(task.task_id)).map((l) => ({
      step_id: l.step_id,
      role: l.role,
      model: l.model,
      tool_calls: scrub(
        l.tool_calls.map((c) => ({
          tool: c.tool,
          args: c.args,
          blocked: c.blocked,
          error: c.error,
        })),
      ),
      output: scrub(l.output),
      check_result: l.check_result,
      tokens: l.tokens,
      cost_gbp: l.cost_gbp,
    })),
    approvals: (await storage.approvals.forTask(task.task_id)).map((a) => ({
      step_id: a.step_id,
      decision: a.decision,
      edited_text: a.edited_text,
      item_shown: scrub(a.item_shown),
    })),
  };
}

const EDIT =
  "Hi,\n\nA short note from Archie about your website. Would a quick call next week help?";

export async function runGraphG1Gate(_storage: Storage, root: string) {
  const policy = loadGraphPolicy();
  const infra = loadInfraConfig();

  // 1. One failing fixture per compiler rule.
  const fixLib = fixtureLibrary(policy);
  const base = await compile(baseSpec(), fixLib, policy, baseContext());
  const ruleResults: { rule: string; name: string; caught: boolean }[] = [];
  for (const f of RULE_FIXTURES) {
    const s = structuredClone(baseSpec());
    f.mutate(s);
    const r = await compile(s, fixLib, f.policy ? f.policy(policy) : policy, {
      ...baseContext(),
      ...(f.ctx ?? {}),
    });
    ruleResults.push({
      rule: f.rule,
      name: f.name,
      caught: !r.ok && r.errors.some((e) => e.rule === f.rule),
    });
  }
  const uncovered = RULES.filter(
    (r) => r !== "reproducible" && !RULE_FIXTURES.some((f) => f.rule === r),
  );
  const again = await compile(baseSpec(), fixLib, policy, baseContext());

  // 2. All seven playbooks as graphs: committed graph.json files, compiled against the live library.
  const A = await world(root);
  const B = await world(root);
  const lib = await libraryFor(A.service);
  const fresh = await convertedGraphs();
  const compiledByPb = new Map<string, CompiledGraph>();
  const compileRows: { pb: string; ok: boolean; current: boolean; errors: string[] }[] = [];
  for (const p of A.service.playbooks.values()) {
    const name = p.spec.playbook;
    const committed = JSON.parse(
      readFileSync(join(root, "playbooks", name, "graph.json"), "utf8"),
    ) as GraphSpec;
    const current =
      name === "claim_site" || JSON.stringify(committed) === JSON.stringify(fresh.get(name));
    const r = await compile(committed, lib, policy, {
      taskLane: "open",
      perTaskCapGbp: p.spec.budget_gbp,
      earnedAutonomy: p.spec.autonomy,
    });
    if (r.compiled) compiledByPb.set(name, r.compiled);
    compileRows.push({
      pb: name,
      ok: r.ok,
      current,
      errors: r.errors.map((e) => `${e.rule}@${e.nodeId}: ${e.message}`),
    });
  }
  // Narrowing evidence: without it, sme_outreach's research (allowed web_fetch) can't feed the send (rule 9).
  const outreach = A.service.playbooks.get("sme_outreach");
  const saved = CONVERSION_NARROWING.sme_outreach;
  delete CONVERSION_NARROWING.sme_outreach;
  const unnarrowed = outreach
    ? await compile(
        playbookToGraph(shapeOf(outreach), {
          outreachSendTools: policy.guardrails.outreach_send_tools,
        }),
        lib,
        policy,
        {
          taskLane: "open",
          perTaskCapGbp: outreach.spec.budget_gbp,
          earnedAutonomy: outreach.spec.autonomy,
        },
      )
    : null;
  if (saved) CONVERSION_NARROWING.sme_outreach = saved;

  // 3. Equivalence: the same fixtures on the old runner (A) and as graphs (B).
  const diffs: string[] = [];
  const rows: string[] = [];
  for (const sc of SCENARIOS) {
    const runOne = async (w: typeof A, graph: boolean) => {
      const e = w.entities[sc.entity] as string;
      const state =
        sc.playbook === "watch_alert"
          ? {
              change: {
                watch_id: w.watchId,
                field: "company_status",
                old_value: "active",
                new_value: "liquidation",
                version: 2,
                watch: {
                  id: w.watchId,
                  customer_id: "cust-fixture",
                  entity_id: e,
                  fields: ["company_status"],
                  channel: "email",
                  target: "alerts@example.co.uk",
                  active: true,
                },
              },
            }
          : (sc.state?.(e) ?? undefined);
      const { task } = await createTask(w.storage, infra, w.service.playbooks, w.service.queue, {
        idempotency_key: `g1:${sc.name}`,
        playbook: sc.playbook,
        revenue_path: (w.service.playbooks.get(sc.playbook)?.spec.revenue_path ??
          "sme_outreach") as never,
        source_ref: sc.ref?.(e) ?? `opportunity:g1-${sc.entity}:entity:${e}`,
        lane: "open",
        ...(state ? { state } : {}),
      });
      const compiled = compiledByPb.get(sc.playbook) as CompiledGraph;
      const d = { storage: w.storage, cfg: infra, runner: w.service.runner };
      let t = graph
        ? await runTaskAsGraph(d, task.task_id, compiled)
        : await w.service.runner.run(task.task_id);
      for (const dec of sc.decisions) {
        if (t.status !== "awaiting_approval") break;
        const text = dec === "edit" ? EDIT : null;
        t = graph
          ? await runTaskAsGraph(d, task.task_id, compiled, { decision: dec, editedText: text })
          : await w.service.runner.decide(task.task_id, dec, text);
      }
      return recordsOf(w.storage, t);
    };
    const a = await runOne(A, false);
    const b = await runOne(B, true);
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same && process.env.G1_DIFF_DIR) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(process.env.G1_DIFF_DIR, `${sc.entity}-old.json`),
        JSON.stringify(a, null, 1),
      );
      writeFileSync(
        join(process.env.G1_DIFF_DIR, `${sc.entity}-graph.json`),
        JSON.stringify(b, null, 1),
      );
    }
    if (!same)
      diffs.push(
        `${sc.name}: old ${JSON.stringify(a).slice(0, 400)} | graph ${JSON.stringify(b).slice(0, 400)}`,
      );
    rows.push(
      `${sc.name} → ${a.status}, ${a.log.length} steps, ${a.approvals.length} approvals${same ? "" : " (DIFFERS)"}`,
    );
  }
  const graphTagged = (await B.storage.audit.tablesContaining("pb-sme-outreach")).includes(
    "run_log",
  );

  const six = compileRows.filter((r) => r.pb !== "claim_site");
  const claim = compileRows.find((r) => r.pb === "claim_site");
  const criteria: GateCriterion[] = [
    {
      criterion: "Each compiler rule has a failing fixture test (the valid base graph compiles)",
      status:
        base.ok && ruleResults.every((r) => r.caught) && uncovered.length === 0
          ? "passed (synthetic)"
          : "failed",
      evidence: `${ruleResults.length} fixtures over ${new Set(ruleResults.map((r) => r.rule)).size} rules, all caught: ${ruleResults.map((r) => `${r.rule} (${r.name})`).join("; ")}`,
    },
    {
      criterion:
        "Reproducible compile: the same spec and registry version always give the same hash",
      status:
        base.compiled?.contentHash === again.compiled?.contentHash
          ? "passed (synthetic)"
          : "failed",
      evidence: `hash ${base.compiled?.contentHash.slice(0, 16)}… twice; a new registry version changes it (unit test)`,
    },
    {
      criterion:
        "The six runner playbooks convert and compile against the live registry; their graph.json files are current",
      status:
        six.length === 6 && six.every((r) => r.ok && r.current) ? "passed (synthetic)" : "failed",
      evidence: six
        .map(
          (r) =>
            `${r.pb}: ${r.ok ? "compiles" : `REJECTED ${r.errors.join("; ")}`}${r.current ? "" : " (graph.json out of date)"}`,
        )
        .join(" · "),
    },
    {
      criterion:
        "Each converted playbook produces the same run log as the old runner on the same fixtures (steps, tool calls, approvals)",
      status: diffs.length === 0 && graphTagged ? "passed (synthetic)" : "failed",
      evidence: diffs.length
        ? diffs.join(" || ")
        : `${rows.join("; ")}; graph run-log rows carry graph id, version and node id`,
    },
    {
      criterion:
        "claim_site, converted by hand from its fulfilment workflow, is rejected by the compiler and keeps running unchanged on its workflow (decision for Archie)",
      status: claim && !claim.ok ? "passed (synthetic)" : "failed",
      evidence: claim ? claim.errors.join("; ") : "missing",
    },
    {
      criterion:
        "Narrowing is honest: without it the compiler refuses sme_outreach (rule 9); with it the run logs above are identical",
      status:
        unnarrowed && !unnarrowed.ok && unnarrowed.errors.some((e) => e.rule === "untrusted")
          ? "passed (synthetic)"
          : "failed",
      evidence: unnarrowed
        ? unnarrowed.errors.map((e) => `${e.rule}@${e.nodeId}: ${e.message}`).join("; ")
        : "no sme_outreach",
    },
  ];
  return { criteria };
}
