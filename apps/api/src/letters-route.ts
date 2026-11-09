import { loadInfraConfig } from "@ae/config";
import {
  batchPdf,
  createPrintBatch,
  decidePrintBatch,
  demoUrl,
  letterSuppressionKey,
  servableDemo,
} from "@ae/infra";
import type { Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";

const BatchDecision = z.object({
  decision: z.enum(["approve", "reject"]),
  /** Letters to leave out of an approved batch (e.g. flagged accountant addresses). */
  exclude: z.array(z.string()).max(1000).default([]),
});

/**
 * sme_letter: the print queue (dashboard, behind Access) and the demo pages (public, noindex).
 */
export function mountLetters(
  // biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
  app: Hono<any>,
  storageFor: (env: unknown) => Storage,
  decide?: (taskId: string, d: "approve" | "reject", edited: string | null) => Promise<unknown>,
) {
  app.get("/api/letters", async (c) => {
    const s = storageFor(c.env);
    const cfg = loadInfraConfig();
    const batches = await s.printBatches.list(10);
    const withLetters = [];
    for (const b of batches)
      withLetters.push({
        ...b,
        letters: (await s.letters.list({ batchId: b.id })).map((l) => ({
          ...l,
          demo_url: demoUrl(cfg, l.demo_slug),
        })),
      });
    return c.json({
      waiting: await s.letters.list({ status: "waiting" }),
      batches: withLetters,
      known_bias:
        "Registered offices are often an accountant's or formation agent's address, so a letter may not reach the directors. Flagged letters say why.",
    });
  });

  // Assemble a batch now instead of waiting for the weekly one.
  app.post("/api/letters/batches", async (c) => {
    const b = await createPrintBatch(storageFor(c.env), loadInfraConfig(), { force: true });
    return b ? c.json(b, 201) : c.json({ error: "nothing_waiting" }, 409);
  });

  app.get("/api/letters/batches/:id/pdf", async (c) => {
    const s = storageFor(c.env);
    const b = await s.printBatches.get(c.req.param("id"));
    if (!b) return c.json({ error: "not_found" }, 404);
    const pdf = await batchPdf(s, b.id);
    return new Response(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="print-batch-${b.week}.pdf"`,
      },
    });
  });

  app.post("/api/letters/batches/:id/decision", async (c) => {
    const body = BatchDecision.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "bad_request", issues: body.error.issues }, 400);
    const s = storageFor(c.env);
    const b = await s.printBatches.get(c.req.param("id"));
    if (!b) return c.json({ error: "not_found" }, 404);
    if (b.status !== "pending") return c.json({ error: `already_${b.status}` }, 409);
    const r = await decidePrintBatch(
      s,
      loadInfraConfig(),
      b.id,
      body.data.decision,
      body.data.exclude,
      async (taskId, d) => {
        if (decide) return decide(taskId, d, null);
        // On Cloudflare the runner applies it on its next tick (same as single decisions).
        const t = await s.tasks.get(taskId);
        if (t?.status === "awaiting_approval")
          await s.tasks.update(taskId, {
            state: {
              ...t.state,
              pending_decision: { decision: d, edited_text: null, at: new Date().toISOString() },
            },
          });
      },
    );
    return c.json({
      ...r,
      note: r.demo_links_live
        ? "Demo links are live."
        : "Demo links stay offline while external actions are switched off for sme_letter (kill switch).",
    });
  });

  // "No more letters" (a reply by post or email): adds the company to the shared suppression list.
  app.post("/api/letters/opt-out/:entity", async (c) => {
    const entity = c.req.param("entity").toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(entity)) return c.json({ error: "bad_company_number" }, 400);
    await storageFor(c.env).suppressions.add(
      letterSuppressionKey(entity),
      "asked for no more letters",
    );
    return c.json({ ok: true, suppressed: letterSuppressionKey(entity) });
  });

  // Public demo homepage. Not indexed; only for approved letters while external actions are allowed.
  app.get("/demo/:slug", async (c) => {
    const page = await servableDemo(storageFor(c.env), loadInfraConfig(), c.req.param("slug"));
    const headers = { "X-Robots-Tag": "noindex, nofollow, noarchive", "Cache-Control": "no-store" };
    if (!page) return c.text("Not found", 404, headers);
    return c.html(page.html, 200, headers);
  });
}
