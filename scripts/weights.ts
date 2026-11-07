import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acceptSuggestion,
  parseFramework,
  rejectSuggestion,
  suggestWeights,
  writeSuggestion,
} from "@ae/opportunity";
import { log, openDb, ROOT } from "./lib.ts";

// pnpm weights suggest [module] | accept <id> [module] | reject <id> [module]
// Weights only ever change when Archie runs `accept`.
const [cmd, a, b] = process.argv.slice(2);
const module = (cmd === "suggest" ? a : b) ?? "lead_gen_sme_web";
const path = resolve(ROOT, `brain/frameworks/${module}.md`);
const note = readFileSync(path, "utf8");
const storage = await openDb();
if (cmd === "suggest") {
  const fw = await parseFramework(note);
  const s = await suggestWeights(storage, fw);
  if (!s) log("Not enough closed outcome windows yet to suggest weights.");
  else {
    writeFileSync(path, await writeSuggestion(storage, note, fw, s));
    log(`Suggestion ${s.id} written to ${path}`);
  }
} else if (cmd === "accept" && a) {
  writeFileSync(path, await acceptSuggestion(storage, note, a));
  log(`Accepted ${a}: weights updated and version bumped in ${path}`);
} else if (cmd === "reject" && a) {
  writeFileSync(path, await rejectSuggestion(storage, note, a));
  log(`Rejected ${a}`);
} else {
  console.error(
    "Usage: pnpm weights suggest [module] | accept <id> [module] | reject <id> [module]",
  );
  process.exit(1);
}
await storage.close();
