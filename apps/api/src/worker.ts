import type { Job } from "@ae/agent-runner/runtime";
import { loadCompaniesHouseConfig, loadInfraConfig } from "@ae/config";
import { externalActionsAllowed } from "@ae/infra";
import { assertStripeTestMode, guardedPayments, StripeCheckout } from "@ae/ports";
import { guardedFacilitator, liveRefresh } from "@ae/products";
import { HttpX402Facilitator } from "@ae/products/x402-real";
import { createD1Storage } from "@ae/storage";
import { CompaniesHouseClient, defaultContext } from "@ae/verification";
import { requireAccess } from "./access.ts";
import { createApp } from "./app.ts";
import { cloudflareWorkflowPort, email, queue, scheduled } from "./runtime-worker.ts";

// Composition root for Cloudflare. Bindings and vars are declared in wrangler.jsonc; secrets
// (CH_API_KEY) are Worker secrets. x402 switches on only when a REAL facilitator URL and a pay-to
// wallet are configured, and payments are refused while the kill switch is on. Card payments switch on
// only when STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Worker secrets) and PUBLIC_BASE_URL are set.
let x402App: ReturnType<typeof createApp> | null = null;
let plainApp: ReturnType<typeof createApp> | null = null;

function build(env: Env) {
  const vars = env as unknown as Record<string, string | undefined>;
  const storage = createD1Storage(env.DB);
  const auth = requireAccess({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    policyAud: env.ACCESS_POLICY_AUD,
  });
  // v2 rule 9: test mode only. A live key leaves card payments switched off (and says so in the log).
  const stripeKeyOk = (() => {
    if (!vars.STRIPE_SECRET_KEY) return false;
    try {
      assertStripeTestMode(vars.STRIPE_SECRET_KEY);
      return true;
    } catch (e) {
      console.error((e as Error).message);
      return false;
    }
  })();
  const payments =
    vars.STRIPE_SECRET_KEY && stripeKeyOk && vars.STRIPE_WEBHOOK_SECRET && vars.PUBLIC_BASE_URL
      ? {
          // No checkout while the product can't be delivered (kill switch on).
          provider: guardedPayments(new StripeCheckout(vars.STRIPE_SECRET_KEY), (product) =>
            externalActionsAllowed(
              storage,
              loadInfraConfig(),
              product === "human_report"
                ? "human_report"
                : product === "claim_site"
                  ? "claim_site"
                  : "monitoring_subscription",
            ),
          ),
          webhookSecret: vars.STRIPE_WEBHOOK_SECRET,
          publicBaseUrl: vars.PUBLIC_BASE_URL,
        }
      : undefined;
  const facilitatorUrl = vars.X402_FACILITATOR_URL;
  const payTo = vars.X402_PAY_TO;
  if (!facilitatorUrl || !payTo) {
    plainApp ??= createApp({
      runtime: "worker",
      storage: (e) => createD1Storage((e as Env).DB),
      workflows: (e) => cloudflareWorkflowPort(e as Env),
      auth,
      ...(payments ? { payments } : {}),
    });
    return plainApp;
  }
  const infra = loadInfraConfig();
  const ch = loadCompaniesHouseConfig();
  x402App ??= createApp({
    runtime: "worker",
    storage: (e) => createD1Storage((e as Env).DB),
    workflows: (e) => cloudflareWorkflowPort(e as Env),
    auth,
    ...(payments ? { payments } : {}),
    x402: {
      facilitator: guardedFacilitator(new HttpX402Facilitator(facilitatorUrl), () =>
        externalActionsAllowed(storage, infra, "x402_check"),
      ),
      payTo,
      refresh: async (n) =>
        vars.CH_API_KEY
          ? liveRefresh(
              storage,
              defaultContext(),
              new CompaniesHouseClient({ apiKey: vars.CH_API_KEY, config: ch }),
              ch,
              n,
            )
          : false,
    },
  });
  return x402App;
}

export { BudgetObject, ChangeFeed, EngineWorkflow } from "./runtime-worker.ts";

export default {
  fetch(request, env, ctx) {
    return build(env).fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await scheduled(env);
  },
  async email(message, env) {
    await email(message, env);
  },
  async queue(batch, env) {
    await queue(batch as MessageBatch<Job>, env);
  },
} satisfies ExportedHandler<Env>;
