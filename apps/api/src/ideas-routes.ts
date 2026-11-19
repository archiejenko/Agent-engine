import type { IdeaCard } from "@ae/contracts";
import {
  addComment,
  boardView,
  completeLegalCheck,
  type DecisionDeps,
  ideaFeed,
  needsLegalCheck,
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
  const planStatus = async (s: Storage, cardId: string) => {
    const specs = (await s.graphSpecs.list({ limit: 500 })).filter(
      (g) => g.opportunity_id === cardId,
    );
    const last = specs.at(-1);
    return last ? last.status : "not planned yet";
  };

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
