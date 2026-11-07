import { createD1Storage } from "@ae/storage";
import { requireAccess } from "./access.ts";
import { createApp } from "./app.ts";

// Composition root for Cloudflare. Bindings and vars are declared in wrangler.jsonc.
const app = createApp({
  runtime: "worker",
  storage: (env) => createD1Storage((env as Env).DB),
  auth: async (c, next) => {
    const env = c.env as Env;
    return requireAccess({ teamDomain: env.ACCESS_TEAM_DOMAIN, policyAud: env.ACCESS_POLICY_AUD })(
      c,
      next,
    );
  },
});

export default app satisfies ExportedHandler<Env>;
