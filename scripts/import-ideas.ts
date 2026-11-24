import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { IDEA_MATRIX_PATH, IDEAS_PATH, importIdeaMatrix, importIdeas } from "@ae/infra";
import { openSqliteStorage } from "@ae/storage/sqlite";
import { ROOT } from "./lib.ts";

// Imports an ideas sheet from brain/ideas/ into a local database (default data/dev.sqlite; AE_DB=... for
// another). On Cloudflare the same import runs from the dashboard: Vault → Ideas sheet → Import.
//   pnpm ideas:import --sheet ranked   (brain/ideas/ranked-ideas.csv, Archie's four-score matrix)
//   pnpm ideas:import --sheet seed     (brain/ideas/seed-500.csv)
const { values } = parseArgs({ options: { sheet: { type: "string", default: "ranked" } } });
const storage = await openSqliteStorage(process.env.AE_DB ?? resolve(ROOT, "data/dev.sqlite"));
const path = values.sheet === "seed" ? IDEAS_PATH : IDEA_MATRIX_PATH;
const text = readFileSync(resolve(ROOT, path), "utf8");
const r =
  values.sheet === "seed"
    ? await importIdeas(storage, text, { by: "archie (local script)" })
    : await importIdeaMatrix(storage, text, { by: "archie (local script)" });
console.log(`${path}: ${JSON.stringify(r)}`);
await storage.close();
