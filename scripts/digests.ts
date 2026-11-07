import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { marginReport, moduleDigest, parseFramework } from "@ae/opportunity";
import { log, openDb, ROOT } from "./lib.ts";

// Weekly digests into brain/digests: one per framework note, plus the margin report.
const storage = await openDb();
mkdirSync(resolve(ROOT, "brain/digests"), { recursive: true });
for (const f of readdirSync(resolve(ROOT, "brain/frameworks")).filter((x) => x.endsWith(".md"))) {
  const d = await moduleDigest(
    storage,
    await parseFramework(readFileSync(resolve(ROOT, "brain/frameworks", f), "utf8")),
  );
  writeFileSync(resolve(ROOT, d.path), d.markdown);
  log(`wrote ${d.path}`);
}
const m = await marginReport(storage);
writeFileSync(resolve(ROOT, m.path), m.markdown);
log(`wrote ${m.path}`);
await storage.close();
