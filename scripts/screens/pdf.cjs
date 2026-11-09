// Renders docs/screens/_print.html to screens.pdf (A5 portrait pages: readable on a phone).
const { chromium } = require("playwright");
const { resolve, join } = require("node:path");
const { rmSync } = require("node:fs");

(async () => {
  const dir = resolve(process.argv[2]);
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.emulateMedia({ media: "print", colorScheme: "light" });
  await p.goto(`file://${join(dir, "_print.html")}`, { waitUntil: "load" });
  await p.pdf({ path: join(dir, "screens.pdf"), preferCSSPageSize: true, printBackground: true });
  await b.close();
  rmSync(join(dir, "_print.html"));
})();
