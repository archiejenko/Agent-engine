import { Miniflare } from "miniflare";
import { d1Driver } from "../d1.ts";
import { storageSuite } from "./suite.ts";

// Miniflare runs Cloudflare's real D1 implementation locally: three databases, as in wrangler.jsonc.
storageSuite("Cloudflare D1 (Miniflare)", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: ["DB", "FACTS", "TELEMETRY"],
  });
  return {
    drivers: {
      core: d1Driver(await mf.getD1Database("DB")),
      facts: d1Driver(await mf.getD1Database("FACTS")),
      telemetry: d1Driver(await mf.getD1Database("TELEMETRY")),
    },
    dispose: () => mf.dispose(),
  };
});
