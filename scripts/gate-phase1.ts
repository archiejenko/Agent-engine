import { execFileSync } from "node:child_process";
import { loadUniverseConfig } from "@ae/config";
import { log, openDb, ROOT } from "./lib.ts";

// Prints the Phase 1 gate evidence for the database in AE_DB (default data/dev.sqlite):
// companies ingested, % anchored, facts by status, rejections, dropped fields, then runs the gate tests.
const storage = await openDb();
const universe = loadUniverseConfig();
const u = await storage.universe.counts(universe.name);
const progress = await storage.progress.summary(`companies_house:${universe.name}`);
const unanchored = await storage.stats.unanchoredMembers(universe.name);
const counts = await storage.stats.counts();
const facts = await storage.facts.countByStatus();
const anchoredPct = u.included ? (100 * (u.included - unanchored.length)) / u.included : 0;

console.log("\n=== Phase 1 gate evidence ===");
console.log(`Database: ${process.env.AE_DB ?? "data/dev.sqlite"}`);
console.table({
  "Companies in universe (included)": u.included,
  "  of which staff_unknown": u.staff_unknown,
  "Companies excluded": u.excluded,
  "Companies pulled from the API (done)": progress.done,
  "API pulls failed / pending": `${progress.failed} / ${progress.pending}`,
  "Anchored to a CH number with facts": `${(u.included - unanchored.length).toLocaleString()} (${anchoredPct.toFixed(2)}%)`,
  Claims: counts.claims,
  "Re-observations": counts.observations,
  "Current facts": Object.values(facts).reduce((a, b) => a + b, 0),
});
console.log("Facts by status:", facts);
console.log("Universe decisions:", await storage.stats.universeReasons(universe.name));
console.log("Claims rejected by sanity rule:", counts.rejections);
const dropped = await storage.dropped.list();
console.log("Source fields dropped (not in registry):", dropped.length ? dropped : "none");
if (unanchored.length) console.log("Unanchored members (first 20):", unanchored.slice(0, 20));
await storage.close();

const gateMet = u.included >= 10_000 && progress.done >= 10_000 && unanchored.length === 0;
console.log(`\nVolume gate (>= 10,000 ingested, 100% anchored): ${gateMet ? "MET" : "NOT MET"}`);
log("Running the gate tests (asOf + licensed lane)...");
execFileSync("pnpm", ["exec", "vitest", "run", "-t", "GATE"], { cwd: ROOT, stdio: "inherit" });
