import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadModelsConfig, loadVerificationConfig } from "@ae/config";
import { costGbp, type ModelClient, type ModelRequest } from "@ae/ports";
import { AnthropicModelClient } from "@ae/ports/anthropic";
import { GeminiModelClient } from "@ae/ports/gemini";
import { generateSites, pagesForModel, WEBSITE_EXTRACT } from "@ae/verification";
import { loadDevVars, ROOT } from "./lib.ts";

// Runs the SAME website pages through Claude Opus 5.5 and Gemini 4 Hydrogen with the extractor's real
// prompt and schema, and compares them field by field against the fixtures' known answers. Real calls,
// real (small) money: about £0.05 a page for both models together. Needs ANTHROPIC_API_KEY and
// GEMINI_API_KEY in the environment or .dev.vars (values are never printed).
//   pnpm compare:extractors [--pages 20]
// Writes docs/gates/extractor-comparison.md. Nothing is written to any database.
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const vars = loadDevVars();
const key = (n: string) => process.env[n] ?? vars[n] ?? "";
const anthropicKey = key("ANTHROPIC_API_KEY");
const geminiKey = key("GEMINI_API_KEY");
if (!geminiKey) {
  console.error("Needs GEMINI_API_KEY (environment or .dev.vars). Nothing was run.");
  process.exit(2);
}
// Without a Claude key, only Hydrogen runs (scored against the fixtures' known answers); the Opus
// columns say "not run". Nothing is filled in for the side that didn't run.
const withOpus = Boolean(anthropicKey);
const models = loadModelsConfig();
const textCfg = loadVerificationConfig().website_extraction;
const n = Number(arg("pages") ?? 20);

// The synthetic-world fixtures: deterministic companies, each with known answers. (There are no real
// cached pages in this repo to add.)
const companies = Array.from({ length: Math.ceil(n / 0.8) + 4 }, (_, i) => ({
  entity_id: String(10_000_000 + i * 7919).slice(0, 8),
  name: `SAMPLE ${["KITCHENS", "ROOFING", "JOINERY", "PLUMBING", "PRINT"][i % 5]} ${i} LIMITED`,
  postcode: ["M1 1AA", "M14 5RR", "BL1 4QE", "OL1 1HL", "WN1 2DA"][i % 5] as string,
}));
const fx = generateSites(companies, 2026);
const sample = fx.truth.filter((t) => t.has_site).slice(0, n);

const opus: ModelClient | null = withOpus
  ? new AnthropicModelClient(models.roles, { apiKey: anthropicKey })
  : null;
const hydrogen: ModelClient = new GeminiModelClient({
  apiKey: geminiKey,
  model: "gemini-4-hydrogen",
  thinkingLevel: models.website_extractor.gemini_thinking_level,
});

type Facts = Record<string, unknown>;
const norm = (v: unknown) =>
  Array.isArray(v)
    ? JSON.stringify([...v].map((x) => String(x).trim().toLowerCase()).sort())
    : String(v ?? "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
const FIELDS = ["company_number", "trading_address_postcode", "contact_email", "job_postings"];

async function run(m: ModelClient, req: ModelRequest) {
  const t0 = Date.now();
  try {
    const r = await m.complete(req);
    const ms = Date.now() - t0;
    const price = models.prices[r.model] ?? models.prices[m.name];
    const gbp = price ? costGbp(r.usage, price, models.usd_to_gbp) : Number.NaN;
    let facts: Facts = {};
    let valid = true;
    try {
      const p = JSON.parse(r.text) as { facts?: { field: string; value: unknown }[] };
      for (const f of p.facts ?? []) facts[f.field] = f.value;
    } catch {
      valid = false;
      facts = {};
    }
    return { ok: true, valid, facts, ms, gbp, usage: r.usage, error: null as string | null };
  } catch (e) {
    return {
      ok: false,
      valid: false,
      facts: {} as Facts,
      ms: Date.now() - t0,
      gbp: 0,
      usage: null,
      error: (e as Error).message.slice(0, 160),
    };
  }
}

const NOT_RUN = {
  ok: false,
  valid: false,
  facts: {} as Facts,
  ms: 0,
  gbp: 0,
  usage: null,
  error: "not run (no ANTHROPIC_API_KEY)",
} satisfies Awaited<ReturnType<typeof run>>;
const rows: {
  id: string;
  expected: Facts;
  opus: Awaited<ReturnType<typeof run>>;
  hyd: Awaited<ReturnType<typeof run>>;
}[] = [];
for (const t of sample) {
  const c = companies.find((x) => x.entity_id === t.entity_id) as (typeof companies)[number];
  const url = t.url as string;
  const pages = ["", "contact", "careers"].map((p) => ({
    url: `${url}${p}`,
    html: fx.pages.get(`${url}${p}`)?.body ?? "",
  }));
  const forModel = pagesForModel(pages, textCfg);
  const req: ModelRequest = {
    prompt_id: WEBSITE_EXTRACT.id,
    prompt_version: WEBSITE_EXTRACT.version,
    role: "extractor",
    system: WEBSITE_EXTRACT.system,
    user: `Company: ${c.name}. Extract the allowed facts from the website pages below.`,
    untrusted: forModel.pages.map((p) => `--- ${p.url}\n${p.text}`).join("\n\n"),
    json_schema: WEBSITE_EXTRACT.schema as unknown as Record<string, unknown>,
    max_tokens: 2000,
  };
  const expected: Facts = {
    company_number: t.wrong_company ? "09999999" : t.entity_id,
    trading_address_postcode: c.postcode,
    contact_email: `info@site-${t.entity_id}.example`,
    ...(t.jobs.length ? { job_postings: t.jobs } : {}),
  };
  const o = opus ? await run(opus, req) : NOT_RUN;
  const h = await run(hydrogen, req);
  rows.push({ id: t.entity_id, expected, opus: o, hyd: h });
  console.log(
    `${rows.length}/${sample.length} ${t.entity_id}: opus ${opus ? `${o.ms}ms` : "not run"}, hydrogen ${h.ms}ms${h.ok ? "" : ` ERROR ${h.error}`}`,
  );
}

const score = (k: "opus" | "hyd") => {
  let right = 0;
  let wrong = 0;
  let missing = 0;
  let extra = 0;
  const wrongs: string[] = [];
  for (const r of rows) {
    const got = r[k].facts;
    for (const f of FIELDS) {
      if (f in r.expected) {
        if (!(f in got)) missing++;
        else if (norm(got[f]) === norm(r.expected[f])) right++;
        else {
          wrong++;
          wrongs.push(
            `${r.id} ${f}: ${JSON.stringify(got[f])} (expected ${JSON.stringify(r.expected[f])})`,
          );
        }
      } else if (f in got) extra++;
    }
    // The injection asks for company_status / employees: neither may appear.
    for (const bad of ["company_status", "employees", "employees_average"]) if (bad in got) extra++;
  }
  const calls = rows.map((r) => r[k]);
  const okCalls = calls.filter((c) => c.ok);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const sorted = okCalls.map((c) => c.ms).sort((a, b) => a - b);
  return {
    right,
    wrong,
    missing,
    extra,
    wrongs,
    errors: calls.filter((c) => !c.ok).length,
    invalid_json: calls.filter((c) => c.ok && !c.valid).length,
    avg_gbp: avg(okCalls.map((c) => c.gbp)),
    avg_in: avg(okCalls.map((c) => c.usage?.input_tokens ?? 0)),
    avg_out: avg(okCalls.map((c) => c.usage?.output_tokens ?? 0)),
    avg_ms: avg(sorted),
    p90_ms: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
  };
};
// If every Hydrogen call failed (no credit, an outage…), there's nothing to compare: say so and leave
// the report as it was, rather than writing a table of zeros that reads as "Hydrogen got it all wrong".
const failed = rows.filter((r) => !r.hyd.ok);
if (failed.length === rows.length) {
  const reasons = [...new Set(failed.map((r) => r.hyd.error))].join(" | ");
  console.error(`Every Hydrogen call failed, so no comparison was written. Reasons: ${reasons}`);
  process.exit(3);
}
const O = score("opus");
const H = score("hyd");
let agree = 0;
let compared = 0;
for (const r of rows)
  for (const f of FIELDS) {
    if (!(f in r.opus.facts) && !(f in r.hyd.facts)) continue;
    compared++;
    if (norm(r.opus.facts[f]) === norm(r.hyd.facts[f])) agree++;
  }
const expectedTotal = rows.reduce((a, r) => a + FIELDS.filter((f) => f in r.expected).length, 0);
const pct = (x: number, of: number) => (of ? `${((100 * x) / of).toFixed(1)}%` : "n/a");
const line = (name: string, s: ReturnType<typeof score>) =>
  `| ${name} | ${pct(s.right, expectedTotal)} (${s.right}/${expectedTotal}) | ${s.wrong} | ${s.missing} | ${s.extra} | ${s.errors} | ${s.invalid_json} | £${s.avg_gbp.toFixed(4)} | ${Math.round(s.avg_in)} / ${Math.round(s.avg_out)} | ${Math.round(s.avg_ms)} ms (p90 ${s.p90_ms} ms) |`;
const md = `# Website extractor: Claude Opus 5.5 vs Gemini 4 Hydrogen

Run ${new Date().toISOString()} on ${rows.length} synthetic-world fixture sites (3 pages each, cut by the
per-page budget), with the extractor's real prompt and JSON schema. No real cached pages exist in the
repo. Prices: models.json (price table ${models.price_table_version}), USD→GBP ${models.usd_to_gbp}.

| Model | Fields right | Wrong | Missing | Extra (not asked / injected) | Errors | Invalid JSON | Avg cost a call | Avg tokens in / out | Avg latency |
|---|---|---|---|---|---|---|---|---|---|
${withOpus ? line("claude-opus-5-5", O) : "| claude-opus-5-5 | not run: no ANTHROPIC_API_KEY in this session | | | | | | | | |"}
${line("gemini-4-hydrogen", H)}

Field-level agreement between the two models: ${withOpus ? `${pct(agree, compared)} (${agree}/${compared} fields either returned)` : "not measured (Opus not run)"}.

Wrong values, Opus: ${withOpus ? (O.wrongs.length ? O.wrongs.slice(0, 20).join("; ") : "none") : "not run"}

Wrong values, Hydrogen: ${H.wrongs.length ? H.wrongs.slice(0, 20).join("; ") : "none"}
`;
const out = resolve(ROOT, "docs/gates/extractor-comparison.md");
writeFileSync(out, md);
writeFileSync(
  resolve(ROOT, "data/extractor-comparison.json"),
  JSON.stringify({ opus: O, hydrogen: H, agree, compared, rows }, null, 1),
);
console.log(md);
console.log(`Written: ${out}`);
