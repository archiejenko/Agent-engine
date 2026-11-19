import { loadGraphPolicy } from "@ae/config";
import { type CompiledGraph, type GraphSpec, type IdeaCard, SANDBOX_NOTE } from "@ae/contracts";
import {
  addComment,
  boardView,
  completeLegalCheck,
  type DecisionDeps,
  ideaFeed,
  needsLegalCheck,
  planDiff,
  planStatusFor,
  requestAndDecide,
} from "@ae/infra";
import type { Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";

/**
 * v3 Phase 6: the Ideas feed and the Board. Pass / fail / park go through the one decisions path
 * (`POST /api/decisions/:id/decide`); questions, comments and the legal check are thread entries.
 * A question is answered by the planner: in-process locally, through the job queue on Cloudflare.
 */
export type AskQuestion = (cardId: string, text: string, by: string) => Promise<unknown>;

const Text = z.object({ text: z.string().trim().min(1).max(2000) });
const Legal = z.object({ note: z.string().trim().min(1).max(2000) });
const BoardAction = z.object({ action: z.enum(["pin", "unpin", "kill"]) });

export function mountIdeas(
  // biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
  app: Hono<any>,
  storageFor: (env: unknown) => Storage,
  decisionDeps: (env: unknown) => DecisionDeps,
  // biome-ignore lint/suspicious/noExplicitAny: Hono context type is generic across runtimes.
  accessUser: (c: any) => string,
  ask: ((env: unknown) => AskQuestion) | undefined,
) {
  const planStatus = (s: Storage, cardId: string) => planStatusFor(s, cardId);

  app.get("/api/ideas", async (c) => {
    const s = storageFor(c.env);
    const fn = c.req.query("function");
    const market = c.req.query("market");
    const feed = await ideaFeed(s, {
      ...(fn ? { function: fn } : {}),
      ...(market ? { market } : {}),
    });
    const all = await s.ideaCards.list();
    const open = await s.decisions.list({ status: "open", limit: 1000 });
    return c.json({
      cards: await Promise.all(
        feed.map(async (r) => ({
          card: r.card,
          status: r.status,
          status_reason: r.status_reason,
          synthetic: r.synthetic,
          plan_status: await planStatus(s, r.card.card_id),
          legal_check_needed: needsLegalCheck(r.card),
          decision:
            open.find((d) => d.source_ref === `card:${r.card.card_id}@${r.card.version}`) ?? null,
        })),
      ),
      // Never shown as cards: rejected before Archie sees them, with the reason.
      held_back: all
        .filter((r) => ["rejected_underpowered", "blocked_reraise"].includes(r.status))
        .map((r) => ({
          card_id: r.card_id,
          version: r.version,
          status: r.status,
          reason: r.status_reason,
        })),
      filters: {
        functions: [...new Set(all.map((r) => (r.card as IdeaCard).taxonomy_node))].sort(),
        markets: [...new Set(all.map((r) => r.market_key))].sort(),
      },
    });
  });

  app.get("/api/ideas/:card", async (c) => {
    const s = storageFor(c.env);
    const versions = await s.ideaCards.versions(c.req.param("card"));
    if (!versions.length) return c.json({ error: "not_found" }, 404);
    return c.json({
      versions: versions.map((v) => ({
        card: v.card,
        status: v.status,
        status_reason: v.status_reason,
      })),
      thread: await s.ideaThread.forCard(c.req.param("card")),
      experiments: await s.experiments.forCard(c.req.param("card")),
    });
  });

  app.post("/api/ideas/:card/question", async (c) => {
    const b = Text.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    if (!ask) return c.json({ error: "no_planner" }, 503);
    const r = await ask(c.env)(c.req.param("card"), b.data.text, accessUser(c));
    return c.json({ ok: true, result: r ?? { queued: true } });
  });

  app.post("/api/ideas/:card/comment", async (c) => {
    const b = Text.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    await addComment(
      { storage: storageFor(c.env), cfg: decisionDeps(c.env).cfg },
      c.req.param("card"),
      b.data.text,
      accessUser(c),
    );
    return c.json({ ok: true });
  });

  app.post("/api/ideas/:card/legal-check", async (c) => {
    const b = Legal.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const r = await completeLegalCheck(
      { storage: storageFor(c.env), cfg: decisionDeps(c.env).cfg },
      c.req.param("card"),
      b.data.note,
      accessUser(c),
    );
    return c.json({ ok: true, version: r.card.version, status: r.status });
  });

  // G4: the approval card for one plan (latest version), with everything Archie judges it on.
  app.get("/api/plans/:graph", async (c) => {
    const s = storageFor(c.env);
    const versions = await s.graphSpecs.versions(c.req.param("graph"));
    const row = versions.at(-1);
    if (!row) return c.json({ error: "not_found" }, 404);
    const spec = row.spec as GraphSpec;
    const compiled = row.compiled as CompiledGraph | null;
    const prev = [...versions]
      .reverse()
      .find((v) => v.version < row.version && (v.spec as GraphSpec).nodes);
    const card = row.opportunity_id
      ? ((await s.ideaCards.latest(row.opportunity_id))?.card as IdeaCard | undefined)
      : undefined;
    const policy = loadGraphPolicy();
    const sends = new Set(policy.guardrails.outreach_send_tools);
    const external = (n: GraphSpec["nodes"][number]) =>
      (n.kind === "role" && n.ref === "operator") || (n.kind === "tool" && sends.has(n.ref));
    const category = (n: GraphSpec["nodes"][number]) =>
      n.kind === "approval"
        ? "needs_you"
        : n.kind === "role" || n.kind === "subgraph"
          ? "agent"
          : "deterministic";
    const reports = (await s.sandboxReports.forGraph(row.graph_id, row.version)) as {
      report: unknown;
    }[];
    const probes = (await s.sandboxReports.forGraph(`${row.graph_id}-probe`.slice(0, 64))) as {
      report: unknown;
    }[];
    const open = await s.decisions.openFor("graph_plan", `graph:${row.graph_id}@${row.version}`);
    return c.json({
      graph_id: row.graph_id,
      version: row.version,
      status: row.status,
      plan_status: row.opportunity_id ? await planStatus(s, row.opportunity_id) : row.status,
      card_id: row.opportunity_id,
      graph: spec.nodes
        ? {
            nodes: spec.nodes.map((n) => ({
              id: n.id,
              kind: n.kind,
              ref: n.ref,
              category: category(n),
              external: external(n),
              max_cost_gbp: n.budget.maxCostGbp,
            })),
            edges: spec.edges,
            layers: compiled?.plan.layers ?? [spec.nodes.map((n) => n.id)],
          }
        : null,
      goal: spec.goal ?? null,
      success_metric: spec.successMetric ?? null,
      stop_conditions: spec.stopConditions ?? [],
      budget_gbp: spec.budgetGbp ?? null,
      expected_value_gbp: card ? card.economics.expected_profit : null,
      worst_case_gbp: compiled?.worstCaseCostGbp ?? null,
      autonomy: compiled?.autonomy ?? null,
      sandbox: reports.map((r) => r.report),
      probes: probes.map((r) => r.report),
      diff: spec.nodes ? planDiff(prev ? (prev.spec as GraphSpec) : null, spec) : null,
      note: SANDBOX_NOTE,
      actions: open ? { decision_id: open.id, options: open.options } : null,
      rationale: spec.planner ?? null,
      history: versions.map((v) => ({
        version: v.version,
        status: v.status,
        created_by: v.created_by,
      })),
    });
  });

  app.get("/api/board", async (c) => c.json({ tiles: await boardView(storageFor(c.env)) }));

  // Pin, unpin or kill: one tap, recorded through the decisions path (an owner approval).
  app.post("/api/board/:key/action", async (c) => {
    const b = BoardAction.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const key = c.req.param("key");
    if (!(await storageFor(c.env).board.get(key))) return c.json({ error: "not_found" }, 404);
    const x = await requestAndDecide(
      decisionDeps(c.env),
      {
        type: "board",
        source_ref: `board:${key}`,
        summary: `${b.data.action} ${key}`,
        option: b.data.action,
        options: [
          // Last = the safe default: unpin changes nothing that spends or sends.
          { key: "pin", label: "Pin", effect: "Keep it at the top of its column" },
          { key: "kill", label: "Kill", effect: "Move it to killed and stop its running tests" },
          { key: "unpin", label: "Unpin", effect: "Let it sort normally" },
        ],
      },
      accessUser(c),
    );
    return c.json({ ok: true, decision: x });
  });
}
