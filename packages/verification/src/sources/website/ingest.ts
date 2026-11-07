import { Claim } from "@ae/contracts";
import {
  type FetchedPage,
  htmlToText,
  type ModelClient,
  type WebFetcher,
  type WebsiteFinder,
} from "@ae/ports";
import type { EntityRow, Storage } from "@ae/storage";
import type { VerificationContext } from "../../context.ts";
import { canonicalJson, stableUuid } from "../../ids.ts";
import { domainOf, nameSimilarity, normalisePostcode } from "../../resolve.ts";
import { ALLOWED_EXTRACT_FIELDS, ROLE_EMAIL, WEBSITE_EXTRACT } from "./prompts.ts";

/**
 * Website ingestion (Phase 2). Produces:
 * - tier 3 claims read directly from the site (found?, url, https, mobile viewport, copyright year,
 *   last-modified), with record or exact-span evidence;
 * - tier 5 llm_extract claims (company number shown, trading postcode, role-based email, job titles),
 *   each with an exact quote that must appear on the page and contain the value.
 * Fetched pages are untrusted: they go to the model only as data, the model may only return
 * allow-listed fields, and every value is checked in code before it becomes a claim.
 * If the site names a different company, nothing is attached: it goes to the quarantine queue.
 */
export interface WebsitePorts {
  finder: WebsiteFinder;
  fetcher: WebFetcher;
  model: ModelClient;
}

export interface WebsiteResult {
  claims: Claim[];
  quarantined: boolean;
  rejected_extractions: { field: string; reason: string }[];
  model_usage: { input_tokens: number; output_tokens: number; model: string } | null;
}

const PAGES = ["", "contact", "careers"];

export async function collectWebsiteClaims(
  entity: EntityRow,
  ports: WebsitePorts,
  runId: string,
  storage: Storage,
): Promise<WebsiteResult> {
  const result: WebsiteResult = {
    claims: [],
    quarantined: false,
    rejected_extractions: [],
    model_usage: null,
  };
  const mk = async (
    source: string,
    tier: number,
    method: Claim["method"],
    field: string,
    value: Claim["value"],
    evidence: Claim["evidence"],
    at: string,
    entityId: string | null = entity.entity_id,
  ): Promise<Claim> => ({
    claim_id: await stableUuid([
      source,
      entity.entity_id,
      field,
      at.slice(0, 10),
      canonicalJson(value),
    ]),
    entity_id: entityId,
    raw_entity_ref: { source_id: entity.entity_id, name: entity.name },
    field,
    value,
    source,
    source_tier: tier,
    lane: "open",
    method,
    evidence,
    observed_at: at,
    published_at: at,
    fetched_at: at,
    run_id: runId,
  });

  const url = await ports.finder.find(entity);
  const now = new Date().toISOString();
  if (!url) {
    result.claims.push(
      await mk(
        "website_discovery",
        3,
        "scrape",
        "website_found",
        false,
        { kind: "record", ref: "finder:none" },
        now,
      ),
    );
    return result;
  }
  const base = url.endsWith("/") ? url : `${url}/`;
  const pages: FetchedPage[] = [];
  for (const p of PAGES) pages.push(await ports.fetcher.fetch(`${base}${p}`));
  const home = pages[0] as FetchedPage;
  const at = home.fetched_at;
  if (home.status !== 200) {
    result.claims.push(
      await mk(
        "website_discovery",
        3,
        "scrape",
        "website_found",
        false,
        { kind: "record", ref: `${base} → HTTP ${home.status}` },
        at,
      ),
    );
    return result;
  }
  const texts = pages
    .filter((p) => p.status === 200)
    .map((p) => ({ url: p.url, text: htmlToText(p.body), html: p.body }));
  const allText = texts.map((t) => t.text).join("\n");

  // ---- Extraction first: it decides whether this site is really this company's.
  const extracted: { field: string; value: unknown; evidence: string; url: string }[] = [];
  const res = await ports.model.complete({
    prompt_id: WEBSITE_EXTRACT.id,
    prompt_version: WEBSITE_EXTRACT.version,
    role: "extractor",
    system: WEBSITE_EXTRACT.system,
    user: `Company: ${entity.name}. Extract the allowed facts from the website pages below.`,
    untrusted: texts.map((t) => `--- ${t.url}\n${t.text}`).join("\n\n"),
    json_schema: WEBSITE_EXTRACT.schema as unknown as Record<string, unknown>,
    max_tokens: 2000,
  });
  result.model_usage = { ...res.usage, model: res.model };
  let parsed: { facts?: { field: string; value: unknown; evidence: string }[] } = {};
  try {
    parsed = JSON.parse(res.text);
  } catch {
    result.rejected_extractions.push({ field: "*", reason: "model output was not JSON" });
  }
  for (const f of parsed.facts ?? []) {
    const reject = (reason: string) =>
      result.rejected_extractions.push({ field: String(f.field), reason });
    if (!ALLOWED_EXTRACT_FIELDS[f.field]) {
      reject("field not allowed");
      continue;
    }
    if (typeof f.evidence !== "string" || f.evidence.trim() === "") {
      reject("no evidence");
      continue;
    }
    const page = texts.find((t) => t.text.includes(f.evidence));
    if (!page) {
      reject("evidence quote is not on the page");
      continue;
    }
    let value = f.value;
    if (f.field === "company_number") value = String(value).toUpperCase().replace(/\s+/g, "");
    if (f.field === "trading_address_postcode") value = normalisePostcode(String(value));
    if (f.field === "contact_email") value = String(value).toLowerCase();
    if (f.field === "contact_email" && !ROLE_EMAIL.test(String(value))) {
      reject("not a role-based address");
      continue;
    }
    if (f.field === "job_postings" && !Array.isArray(value)) {
      reject("job_postings must be a list");
      continue;
    }
    if (value === null || value === "") {
      reject("unusable value");
      continue;
    }
    extracted.push({ field: f.field, value, evidence: f.evidence, url: page.url });
  }

  // ---- Anchoring: is this website really this company's?
  const shownNumber = extracted.find((e) => e.field === "company_number")?.value as
    | string
    | undefined;
  const tradingPc = extracted.find((e) => e.field === "trading_address_postcode")?.value as
    | string
    | undefined;
  const titleName = home.body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
  const sameNumber = shownNumber === entity.entity_id;
  const otherNumber = shownNumber !== undefined && !sameNumber;
  const nameOk = nameSimilarity(titleName, entity.name) >= 0.6;
  const pcOk = tradingPc !== undefined && tradingPc === entity.postcode;
  if (otherNumber || (!sameNumber && !nameOk && !pcOk)) {
    await storage.quarantine.add({
      source: "company_website",
      raw_ref: base,
      record: {
        entity_id: entity.entity_id,
        title: titleName,
        shown_number: shownNumber ?? null,
        trading_postcode: tradingPc ?? null,
      },
      candidates: [{ entity_id: entity.entity_id, name: entity.name, postcode: entity.postcode }],
      reason: otherNumber
        ? `website shows company number ${shownNumber}, not ${entity.entity_id}`
        : "website doesn't show the company number, and neither name nor postcode match",
    });
    result.quarantined = true;
    return result;
  }

  // ---- Tier 3: read directly from the site.
  const rec = (ref: string) => ({ kind: "record" as const, ref });
  const domain = domainOf(base) ?? base;
  result.claims.push(
    await mk("website_discovery", 3, "scrape", "website_found", true, rec(base), at),
  );
  result.claims.push(
    await mk("company_website", 3, "scrape", "website_url", domain, rec(base), at),
  );
  result.claims.push(
    await mk(
      "company_website",
      3,
      "scrape",
      "website_https",
      base.startsWith("https://"),
      rec(base),
      at,
    ),
  );
  result.claims.push(
    await mk(
      "company_website",
      3,
      "scrape",
      "website_mobile_ready",
      /<meta[^>]+name=["']viewport["']/i.test(home.body),
      rec(`${base} <meta viewport>`),
      at,
    ),
  );
  const lm = home.headers["last-modified"];
  if (lm && !Number.isNaN(Date.parse(lm))) {
    result.claims.push(
      await mk(
        "company_website",
        3,
        "scrape",
        "website_last_modified",
        new Date(Date.parse(lm)).toISOString().slice(0, 10),
        rec(`${base} Last-Modified: ${lm}`),
        at,
      ),
    );
  }
  const years = [...allText.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)];
  const best = years
    .map((m) => ({ year: Number(m[1]), span: m[0] }))
    .filter((y) => y.year >= 1995 && y.year <= new Date(at).getUTCFullYear())
    .sort((a, b) => b.year - a.year)[0];
  if (best) {
    result.claims.push(
      await mk(
        "company_website",
        3,
        "scrape",
        "website_copyright_year",
        best.year,
        { kind: "span", ref: base, text: best.span },
        at,
      ),
    );
  }

  // ---- Tier 5: model extractions. The claim contract re-checks that each value is in its quote;
  // anything that fails is rejected individually (never the whole batch).
  for (const e of extracted) {
    const c = await mk(
      "company_website_llm",
      5,
      "llm_extract",
      ALLOWED_EXTRACT_FIELDS[e.field] as string,
      e.value as Claim["value"],
      { kind: "span", ref: e.url, text: e.evidence },
      at,
    );
    const check = Claim.safeParse(c);
    if (check.success) result.claims.push(c);
    else
      result.rejected_extractions.push({
        field: e.field,
        reason: check.error.issues[0]?.message ?? "invalid claim",
      });
  }
  return result;
}
