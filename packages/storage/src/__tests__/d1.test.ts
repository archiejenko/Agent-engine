import { Miniflare } from "miniflare";
import { d1Driver } from "../d1.ts";
import { storageSuite } from "./suite.ts";

// Miniflare runs Cloudflare's real D1 implementation locally.
storageSuite("Cloudflare D1 (Miniflare)", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  return { driver: d1Driver(db), dispose: () => mf.dispose() };
});
