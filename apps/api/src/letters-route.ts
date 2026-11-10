import { legalDetailsArePlaceholders, loadInfraConfig, tradingDisclosure } from "@ae/config";
import {
  type BlockedItem,
  batchPdf,
  createPrintBatch,
  decidePrintBatch,
  demoUrl,
  letterSuppressionKey,
  optOutByCode,
  renderPublicPage,
  servableDemo,
} from "@ae/infra";
import type { Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";

const SIMPLE = (title: string, extra = "") =>
  renderPublicPage(title, tradingDisclosure(loadInfraConfig().sender), extra);

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
    // Blocked duplicates arrive as one digest alert per day; list their items, newest first.
    const blocked = (await s.alerts.list({ unacknowledged: true, limit: 500 }))
      .filter((a) => a.kind === "contact_blocked")
      .flatMap((a) =>
        ((a.details as { items?: BlockedItem[] } | null)?.items ?? []).map((i, n) => ({
          id: `${a.id}-${n}`,
          message: `${i.name} (${i.entity_id}): no new ${i.playbook === "sme_letter" ? "letter" : "email"}: ${i.reason}`,
          created_at: i.at,
        })),
      )
      .sort((x, y) => y.created_at.localeCompare(x.created_at))
      .slice(0, 50);
    return c.json({
      blocked_duplicates: blocked,
      cooldown_days: cfg.outreach.contact_cooldown_days,
      legal_placeholders: legalDetailsArePlaceholders(cfg.sender),
      cost_per_letter_gbp: cfg.letters.print_cost_gbp + cfg.letters.postage_gbp,
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
    return new Response(new Uint8Array(pdf), {
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

  // Public demo homepage. Not indexed; only for approved letters while external actions are allowed;
  // expires a fixed time after approval. CSP: no external resources at all (no third-party imagery).
  app.get("/demo/:slug", async (c) => {
    const page = await servableDemo(storageFor(c.env), loadInfraConfig(), c.req.param("slug"));
    const headers = {
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'",
    };
    if (!page) return c.html(SIMPLE("This page isn't available."), 404, headers);
    if (page.state === "expired") return c.html(SIMPLE("This sample has expired."), 410, headers);
    return c.html(page.html, 200, headers);
  });

  // Short opt-out URL printed on every letter. GET shows a confirm button (so link previews and
  // prefetchers can't opt anyone out by accident); POST records it. Works even with the kill switch on.
  app.get("/stop/:code", async (c) => {
    const code = c.req.param("code").toUpperCase();
    const letter = await storageFor(c.env).letters.byOptOutCode(code);
    const headers = { "X-Robots-Tag": "noindex", "Cache-Control": "no-store" };
    if (!letter) return c.html(SIMPLE("We couldn't find that code."), 404, headers);
    return c.html(
      SIMPLE(
        `Stop letters to ${letter.company_name}?`,
        `<form method="post"><button type="submit">Yes, no more letters</button></form>`,
      ),
      200,
      headers,
    );
  });
  app.post("/stop/:code", async (c) => {
    const letter = await optOutByCode(
      storageFor(c.env),
      c.req.param("code").toUpperCase(),
      "short URL",
    );
    if (!letter) return c.html(SIMPLE("We couldn't find that code."), 404);
    return c.html(SIMPLE("Done: you won't receive any more letters from us."), 200, {
      "X-Robots-Tag": "noindex",
    });
  });
}
