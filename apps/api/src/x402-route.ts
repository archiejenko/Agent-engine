import { loadModelsConfig, loadProductsConfig } from "@ae/config";
import {
  companyCheck,
  HEADERS,
  priceFor,
  type SettleResponse,
  unb64,
  type X402Facilitator,
} from "@ae/products";
import type { Storage } from "@ae/storage";
import type { VerificationContext } from "@ae/verification";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import type { Hono } from "hono";

export interface X402Deps {
  facilitator: X402Facilitator;
  payTo: string;
  /** Premium tier: re-verify the company live before answering. Returns false if it couldn't. */
  refresh?: (companyNumber: string) => Promise<boolean>;
}

const PATH = "/x402/check/:number";

/** Cache the facilitator's supported kinds as a value (10 minutes). */
function cacheSupported(f: X402Facilitator): X402Facilitator {
  let cached: { at: number; value: Awaited<ReturnType<X402Facilitator["getSupported"]>> } | null =
    null;
  return {
    dryRun: f.dryRun,
    verify: (p, r) => f.verify(p, r),
    settle: (p, r) => f.settle(p, r),
    async getSupported() {
      if (cached && Date.now() - cached.at < 600_000) return cached.value;
      const value = await f.getSupported();
      cached = { at: Date.now(), value };
      return value;
    },
  };
}

/**
 * The paid company check, using the official x402 v2 middleware. Order on each request:
 *  1. our pre-check: bad number → 400; unknown company → 404 (free, never challenged);
 *  2. `paymentMiddleware`: no PAYMENT-SIGNATURE → 402 + PAYMENT-REQUIRED; else verify with the
 *     facilitator (kill-switch guarded);
 *  3. our handler does the work (premium: live re-check first, 503 if it can't);
 *  4. the middleware settles only when the handler answered < 400, and adds PAYMENT-RESPONSE;
 *  5. our pre-check (on the way out) logs the outcome and records settled payments in the ledger.
 */
export function mountX402(
  // biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
  app: Hono<any>,
  x: X402Deps | undefined,
  storageFor: (env: unknown) => Storage,
  vctx: VerificationContext,
) {
  const cfg = loadProductsConfig().x402;
  const tierOf = (q: string | string[] | undefined) =>
    (Array.isArray(q) ? q[0] : q) === "premium" ? "premium" : "cached";

  if (x) {
    app.use(PATH, async (c, next) => {
      const started = Date.now();
      const number = c.req.param("number").toUpperCase();
      const tier = tierOf(c.req.query("tier"));
      const s = storageFor(c.env);
      const usdToGbp = loadModelsConfig().usd_to_gbp;
      const log = (
        status: Parameters<typeof s.x402.log>[0]["status"],
        extra: { payer?: string | null; tx?: string | null; cost?: number } = {},
      ) =>
        s.x402.log({
          id: crypto.randomUUID(),
          company_number: number,
          tier,
          status,
          price_usd: status === "served" ? cfg.prices_usd[tier] : 0,
          price_gbp: status === "served" ? cfg.prices_usd[tier] * usdToGbp : 0,
          cost_gbp: extra.cost ?? 0,
          payer: extra.payer ?? null,
          transaction_ref: extra.tx ?? null,
          network: cfg.network,
          latency_ms: Date.now() - started,
          dry_run: x.facilitator.dryRun,
          task_id: null,
        });
      if (!/^[A-Z0-9]{8}$/.test(number)) return c.json({ error: "bad_company_number" }, 400);
      // Unknown companies are free to ask about: nothing to sell.
      if (
        !(await s.entities.get(number)) &&
        (await s.facts.listCurrent({ entityId: number, limit: 1, offset: 0 })).total === 0
      ) {
        await log("not_found");
        return c.json({ error: "not_found", company_number: number }, 404);
      }
      const paid = Boolean(c.req.header(HEADERS.signature));
      await next();
      const res = c.res;
      const responseHeader = res.headers.get(HEADERS.response);
      if (res.status === 200 && responseHeader) {
        const settled = unb64<SettleResponse>(responseHeader);
        await s.ledger.record({
          rail: "x402",
          reference: settled.transaction,
          payer: settled.payer ?? null,
          amount_gbp: cfg.prices_usd[tier] * usdToGbp,
          currency_amount: `${priceFor(cfg, tier).amount} ${cfg.asset}@${cfg.network}`,
          dry_run: x.facilitator.dryRun,
          task_id: null,
        });
        await log("served", {
          payer: settled.payer ?? null,
          tx: settled.transaction,
          cost: cfg.cost_per_call_gbp[tier] + cfg.facilitator_fee_gbp,
        });
      } else if (res.status === 402) {
        await log(!paid ? "challenge" : responseHeader ? "settle_failed" : "invalid_payment");
      } else {
        await log("failed");
      }
    });

    const facilitator = cacheSupported(x.facilitator);
    const routes = {
      "GET /x402/check/*": {
        accepts: {
          scheme: "exact",
          network: cfg.network as `${string}:${string}`,
          payTo: x.payTo,
          price: (ctx: {
            adapter: { getQueryParam?: (n: string) => string | string[] | undefined };
          }) => priceFor(cfg, tierOf(ctx.adapter.getQueryParam?.("tier"))),
          maxTimeoutSeconds: cfg.max_timeout_seconds,
        },
        description: "UK company check: verified facts with per-field confidence",
        mimeType: "application/json",
        unpaidResponseBody: async () => ({
          contentType: "application/json",
          body: { error: "payment required", see: HEADERS.required },
        }),
      },
    };
    // Built per request: on Cloudflare a promise started in one request can't be awaited by another,
    // so the middleware's start-up sync must belong to this request. The facilitator's /supported
    // answer is cached as a plain value, so this costs one facilitator call per isolate, not per request.
    app.use(PATH, (c, next) => {
      const server = new x402ResourceServer(facilitator).register(
        cfg.network as `${string}:${string}`,
        new ExactEvmScheme(),
      );
      return paymentMiddleware(routes, server)(c, next);
    });
  }

  app.get(PATH, async (c) => {
    if (!x) return c.json({ error: "x402_disabled" }, 404);
    const number = c.req.param("number").toUpperCase();
    const tier = tierOf(c.req.query("tier"));
    const s = storageFor(c.env);
    let refreshed = false;
    if (tier === "premium") {
      refreshed = x.refresh ? await x.refresh(number).catch(() => false) : false;
      // ≥ 400 → the middleware cancels settlement: the agent isn't charged.
      if (!refreshed)
        return c.json(
          { error: "live re-verification failed; you have not been charged", retry: true },
          503,
        );
    }
    const result = await companyCheck(s, vctx, number, { tier, caller: "x402", refreshed });
    if (!result) return c.json({ error: "no verified facts; you have not been charged" }, 404);
    return c.json(result, 200);
  });
}
