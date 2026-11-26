import type { Job } from "@ae/agent-runner/runtime";
import { loadCompaniesHouseConfig, loadInfraConfig } from "@ae/config";
import { externalActionsAllowed, KeyRing } from "@ae/infra";
import { assertStripeTestMode, guardedPayments, StripeCheckout } from "@ae/ports";
import { guardedFacilitator, liveRefresh } from "@ae/products";
import { HttpX402Facilitator } from "@ae/products/x402-real";
import { createD1Storage } from "@ae/storage";
import { CompaniesHouseClient, defaultContext } from "@ae/verification";
import { requireAccess } from "./access.ts";
import { createApp } from "./app.ts";
import {
  cloudflareWorkflowPort,
  email,
  keyFor,
  queue,
  scheduled,
  workerKeyStore,
} from "./runtime-worker.ts";

// Composition root for Cloudflare. Bindings and vars are declared in wrangler.jsonc; secrets
// (CH_API_KEY) are Worker secrets. x402 switches on only when a REAL facilitator URL and a pay-to
// wallet are configured, and payments are refused while the kill switch is on. Card payments switch on
// only when STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (Worker secrets) and PUBLIC_BASE_URL are set.
// Keys (v3 rule 20) are read through the key ring from Secrets Store (or a Worker secret of the same
// name). The app is rebuilt at most once a minute, so a key saved on the Keys page takes effect quickly.
let cached: { app: ReturnType<typeof createApp>; at: number } | null = null;
const REBUILD_MS = 60_000;

async function build(env: Env) {
  if (cached && Date.now() - cached.at < REBUILD_MS) return cached.app;
  const ring = new KeyRing(workerKeyStore(env), createD1Storage(env.DB));
  const [stripeKey, webhookSecret, chKey] = [
    await keyFor(ring, "STRIPE_SECRET_KEY"),
    await keyFor(ring, "STRIPE_WEBHOOK_SECRET"),
    await keyFor(ring, "CH_API_KEY"),
  ];
  const app = buildWith(env, { stripeKey, webhookSecret, chKey });
  cached = { app, at: Date.now() };
  return app;
}

function buildWith(
  env: Env,
  k: { stripeKey: string | null; webhookSecret: string | null; chKey: string | null },
) {
  const vars = env as unknown as Record<string, string | undefined>;
  const storage = createD1Storage(env.DB);
  const keys = (e: unknown) => workerKeyStore(e as Env);
  const auth = requireAccess({
    teamDomain: env.ACCESS_TEAM_DOMAIN,
    policyAud: env.ACCESS_POLICY_AUD,
  });
  // v2 rule 9: test mode only. A live key leaves card payments switched off (and says so in the log).
  const stripeKeyOk = (() => {
    if (!k.stripeKey) return false;
    try {
      assertStripeTestMode(k.stripeKey);
      return true;
    } catch (e) {
      console.error((e as Error).message);
      return false;
    }
  })();
  const payments =
    k.stripeKey && stripeKeyOk && k.webhookSecret && vars.PUBLIC_BASE_URL
      ? {
          // No checkout while the product can't be delivered (kill switch on).
          provider: guardedPayments(new StripeCheckout(k.stripeKey), (product) =>
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
          webhookSecret: k.webhookSecret,
          publicBaseUrl: vars.PUBLIC_BASE_URL,
        }
      : undefined;
  const facilitatorUrl = vars.X402_FACILITATOR_URL;
  const payTo = vars.X402_PAY_TO;
  if (!facilitatorUrl || !payTo) {
    return createApp({
      runtime: "worker",
      keys,
      storage: (e) => createD1Storage((e as Env).DB),
      workflows: (e) => cloudflareWorkflowPort(e as Env),
      // Questions on idea cards are answered by the planner in the queue consumer.
      ask: (e) => async (card_id, text, by) => {
        await (e as Env).JOBS.send({ kind: "idea_question", card_id, text, by });
        return { queued: true };
      },
      auth,
      ...(payments ? { payments } : {}),
    });
  }
  const infra = loadInfraConfig();
  const ch = loadCompaniesHouseConfig();
  return createApp({
    runtime: "worker",
    keys,
    storage: (e) => createD1Storage((e as Env).DB),
    workflows: (e) => cloudflareWorkflowPort(e as Env),
    // Questions on idea cards are answered by the planner in the queue consumer.
    ask: (e) => async (card_id, text, by) => {
      await (e as Env).JOBS.send({ kind: "idea_question", card_id, text, by });
      return { queued: true };
    },
    auth,
    ...(payments ? { payments } : {}),
    x402: {
      facilitator: guardedFacilitator(new HttpX402Facilitator(facilitatorUrl), () =>
        externalActionsAllowed(storage, infra, "x402_check"),
      ),
      payTo,
      refresh: async (n) =>
        k.chKey
          ? liveRefresh(
              storage,
              defaultContext(),
              new CompaniesHouseClient({ apiKey: k.chKey, config: ch }),
              ch,
              n,
            )
          : false,
    },
  });
}

export {
  BudgetObject,
  ChangeFeed,
  EngineWorkflow,
  GraphRunWorkflow,
  RunState,
} from "./runtime-worker.ts";

export default {
  async fetch(request, env, ctx) {
    return (await build(env)).fetch(request, env, ctx);
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
