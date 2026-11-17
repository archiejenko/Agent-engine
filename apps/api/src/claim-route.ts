import { loadInfraConfig, loadProductsConfig, tradingDisclosure } from "@ae/config";
import {
  type DecisionDeps,
  DecisionError,
  decideSource,
  externalActionsAllowed,
  handleClaimEvent,
  loadBundledPlaybooks,
  renderClaimPage,
  renderPublicPage,
  servableDemo,
  startClaim,
  type WorkflowPort,
} from "@ae/infra";
import {
  type PaymentProvider,
  PaymentsPausedError,
  toSubscriptionEvent,
  verifyStripeSignature,
  WebhookSignatureError,
} from "@ae/ports";
import type { Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";

/**
 * "Claim this site" (v2 Phase 4): public claim page and form, the customer's details form, the live
 * site, Stripe subscription events, and the dashboard's claims list with publish approval.
 */
const SIMPLE = (title: string, extra = "") =>
  renderPublicPage(title, tradingDisclosure(loadInfraConfig().sender), extra);
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" };
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

const Details = z.object({
  business_description: z.string().trim().min(3).max(500),
  area: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(40).optional(),
  email: z.string().trim().max(200).optional(),
  hours: z.string().trim().max(200).optional(),
});

export interface ClaimDeps {
  storage: (env: unknown) => Storage;
  payments?: { provider: PaymentProvider; webhookSecret: string; publicBaseUrl: string };
  workflows?: (env: unknown) => WorkflowPort;
  decisions?: (env: unknown) => DecisionDeps;
}

// biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
export function mountClaims(app: Hono<any>, deps: ClaimDeps) {
  app.get("/claim/:slug", async (c) => {
    const s = deps.storage(c.env);
    const cfg = loadInfraConfig();
    const slug = c.req.param("slug");
    const page = await servableDemo(s, cfg, slug);
    const demo = await s.demoPages.get(slug);
    if (page?.state !== "live" || !demo || !deps.payments)
      return c.html(SIMPLE("This page isn't available."), 404, NOINDEX);
    const company = (await s.entities.get(demo.entity_id))?.name ?? demo.entity_id;
    return c.html(renderClaimPage(cfg, loadProductsConfig(), slug, company), 200, NOINDEX);
  });

  app.post("/public/claim/:slug", async (c) => {
    if (!deps.payments) return c.html(SIMPLE("This page isn't available."), 404, NOINDEX);
    const form = await c.req.parseBody();
    const b = z
      .object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().email().max(200),
        accept: z.literal("1"),
      })
      .safeParse(form);
    if (!b.success)
      return c.html(
        SIMPLE("Please fill in your name and email and accept the terms."),
        400,
        NOINDEX,
      );
    try {
      const r = await startClaim(
        deps.storage(c.env),
        loadInfraConfig(),
        loadProductsConfig(),
        deps.payments.provider,
        {
          slug: c.req.param("slug"),
          name: b.data.name,
          email: b.data.email,
          accepted: true,
          publicBaseUrl: deps.payments.publicBaseUrl,
        },
      );
      if ("error" in r) return c.html(SIMPLE("This page isn't available."), 404, NOINDEX);
      return c.redirect(r.url, 303);
    } catch (e) {
      if (e instanceof PaymentsPausedError)
        return c.html(SIMPLE("Sorry, we're not taking new sites right now."), 503, NOINDEX);
      throw e;
    }
  });

  app.get("/claim/:slug/thanks", (c) =>
    c.html(
      SIMPLE("Thank you. Check your email for a short form so we can build your site."),
      200,
      NOINDEX,
    ),
  );

  app.get("/claim/details/:token", async (c) => {
    const claim = await deps.storage(c.env).siteClaims.byToken(c.req.param("token"));
    if (!claim || !["paid", "details_received"].includes(claim.status))
      return c.html(SIMPLE("This link isn't valid any more."), 404, NOINDEX);
    return c.html(
      SIMPLE(
        "Tell us about your business",
        `<form method="post" action="/public/claim/details/${esc(claim.details_token)}" style="display:grid;gap:8px;max-width:420px">
<label>What you do (main services, separated by commas) <textarea name="business_description" required maxlength="500"></textarea></label>
<label>Area you cover <input name="area" required maxlength="120"></label>
<label>Phone (optional) <input name="phone" maxlength="40"></label>
<label>Email for enquiries (optional) <input name="email" type="email" maxlength="200"></label>
<label>Opening hours (optional) <input name="hours" maxlength="200"></label>
<button type="submit">Send</button></form>`,
      ),
      200,
      NOINDEX,
    );
  });

  app.post("/public/claim/details/:token", async (c) => {
    const s = deps.storage(c.env);
    const claim = await s.siteClaims.byToken(c.req.param("token"));
    if (claim?.status !== "paid" || !claim.workflow_id || !deps.workflows)
      return c.html(SIMPLE("This link isn't valid any more."), 404, NOINDEX);
    const b = Details.safeParse(await c.req.parseBody());
    if (!b.success)
      return c.html(SIMPLE("Please fill in what you do and the area you cover."), 400, NOINDEX);
    await s.siteClaims.update(claim.id, { status: "details_received" });
    await deps.workflows(c.env).sendEvent(claim.workflow_id, "details", b.data);
    return c.html(
      SIMPLE("Thanks: we'll send you the site to look at before it goes live."),
      200,
      NOINDEX,
    );
  });

  // The live site: only after Archie approved it, and only while external actions are allowed.
  app.get("/s/:slug", async (c) => {
    const s = deps.storage(c.env);
    const cfg = loadInfraConfig();
    const claim = (await s.siteClaims.list({ includeSynthetic: true, limit: 1000 })).find(
      (x) => x.slug === c.req.param("slug") && x.status === "published",
    );
    if (!claim || !(await externalActionsAllowed(s, cfg, "claim_site")))
      return c.html(SIMPLE("This page isn't available."), 404, NOINDEX);
    const d =
      (claim.details as {
        draft?: { headline: string; about: string; services: string[] };
        submitted?: { phone?: string; email?: string };
      }) ?? {};
    const draft = d.draft ?? { headline: "", about: "", services: [] };
    return c.html(
      renderPublicPage(
        draft.headline,
        tradingDisclosure(cfg.sender),
        `<p>${esc(draft.about)}</p><ul>${draft.services.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${d.submitted?.phone ? `<p>Phone: ${esc(d.submitted.phone)}</p>` : ""}${d.submitted?.email ? `<p>Email: ${esc(d.submitted.email)}</p>` : ""}`,
      ),
      200,
      { "Cache-Control": "no-store" },
    );
  });

  // ---- Dashboard (behind Access): claims, minutes against the target, publish approval.
  app.get("/api/claims", async (c) => {
    const s = deps.storage(c.env);
    const p = loadProductsConfig().claim_site;
    const sessions = await s.reviewSessions.since({
      since: new Date(0).toISOString(),
      includeSynthetic: true,
    });
    const claims = await s.siteClaims.list({
      includeSynthetic: c.req.query("synthetic") === "1",
      limit: 100,
    });
    return c.json({
      human_minutes_target: p.human_minutes_target,
      claims: claims.map((x) => ({
        ...x,
        details_token: undefined,
        human_minutes: Number(
          (
            sessions
              .filter((r) => r.item_type === "claim" && r.item_id === x.id)
              .reduce((a, r) => a + r.active_ms, 0) / 60_000
          ).toFixed(1),
        ),
      })),
    });
  });

  // Publishing is a decision in the one queue (rule 18); this route decides it.
  app.post("/api/claims/:id/publish", async (c) => {
    const b = z.object({ approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    const s = deps.storage(c.env);
    const claim = await s.siteClaims.get(c.req.param("id"));
    if (!claim?.workflow_id || !deps.decisions) return c.json({ error: "not_found" }, 404);
    if (claim.status !== "awaiting_publish")
      return c.json({ error: `claim is ${claim.status}` }, 409);
    try {
      const x = await decideSource(
        deps.decisions(c.env),
        "claim_publish",
        `claim:${claim.id}`,
        b.data.approve ? "publish" : "not_yet",
        c.req.header("cf-access-authenticated-user-email") ?? "archie (local dashboard)",
      );
      return c.json({ ok: !x.error, decision_id: x.id });
    } catch (e) {
      if (e instanceof DecisionError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });
}

/**
 * Stripe subscription events for claims. Returns null when the event isn't one of ours (the existing
 * one-off checkout handler takes it).
 */
export async function claimWebhook(
  storage: Storage,
  workflows: WorkflowPort | undefined,
  raw: string,
  signature: string | null,
  secret: string,
) {
  await verifyStripeSignature(raw, signature, secret);
  const ev = toSubscriptionEvent(raw);
  if (!ev || !workflows) return null;
  if (ev.kind === "checkout_completed" && ev.metadata.product !== "claim_site") return null;
  return handleClaimEvent(storage, loadInfraConfig(), await loadBundledPlaybooks(), workflows, ev);
}

export { WebhookSignatureError };
