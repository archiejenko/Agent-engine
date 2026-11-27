import type { ModelRequest } from "@ae/ports";

/**
 * The extraction model's stand-in until cutover (the Worker's fake model uses it while MODEL_LIVE is
 * off). It invents nothing: every value is quoted from the fetched page, with that quote as evidence.
 * Kept apart from synthetic.ts (the fake-website generator), which must never ship in the Worker.
 */
/** Deterministic stand-in for the extraction model: quotes exactly what's on the page. */
export function fakeWebsiteExtractor(req: ModelRequest): string {
  const text = req.untrusted ?? "";
  const facts: { field: string; value: unknown; evidence: string }[] = [];
  const num = text.match(/Company (?:registration )?(?:number|no\.?)[:\s]*([A-Z0-9]{8})/i);
  if (num?.[1]) facts.push({ field: "company_number", value: num[1], evidence: num[0] });
  const addr = text.match(/Address:[^\n]*?([A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2})/);
  if (addr?.[1])
    facts.push({ field: "trading_address_postcode", value: addr[1], evidence: addr[0] });
  const email = text.match(
    /\b(?:info|hello|enquiries|contact|sales|office)@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  );
  if (email) facts.push({ field: "contact_email", value: email[0], evidence: email[0] });
  const jobLines = [...text.matchAll(/^Vacancy: (.+)$/gm)];
  if (jobLines.length) {
    facts.push({
      field: "job_postings",
      value: jobLines.map((m) => (m[1] as string).trim()),
      evidence: jobLines.map((m) => m[0]).join("\n"),
    });
  }
  return JSON.stringify({ facts });
}
