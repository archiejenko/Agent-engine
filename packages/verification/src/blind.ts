import type { CompaniesHouseConfig, ProductsConfig } from "@ae/config";
import type { Storage } from "@ae/storage";
import { agree } from "./agreement.ts";
import type { VerificationContext } from "./context.ts";
import { requestVerification } from "./query.ts";
import { type CompaniesHouseClient, fetchCompanyBundle } from "./sources/companies-house/client.ts";
import { mapCompanyBundle } from "./sources/companies-house/mapper.ts";

/**
 * Blind verifier (Phase 4). For a random sample of facts, re-derives the value straight from the
 * primary source WITHOUT seeing the original claims (it gets only the company number and field name),
 * then compares with what we serve. Disagreements trigger re-verification and an alert. The sample rate
 * adapts per source+field: more disagreement → checked more often.
 */
export const rateKey = (source: string, field: string) => `blind:rate:${source}|${field}`;

export function adaptiveRate(recent: boolean[], cfg: ProductsConfig["blind_verifier"]): number {
  if (recent.length < 20) return cfg.base_rate;
  const disagree = recent.filter((x) => !x).length / recent.length;
  return Math.min(
    cfg.max_rate,
    Math.max(
      cfg.min_rate,
      cfg.base_rate * (1 + cfg.sensitivity * disagree) * (disagree === 0 ? 0.5 : 1),
    ),
  );
}

/** Deterministic sample: hash(entity, field, day) < rate. Same day, same sample (reproducible). */
async function sampled(entity: string, field: string, day: string, rate: number): Promise<boolean> {
  const h = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${entity}|${field}|${day}`)),
  );
  return ((h[0] as number) * 256 + (h[1] as number)) / 65536 < rate;
}

/** Fields the blind verifier can re-derive from Companies House (the primary source). */
const CH_FIELDS = new Set([
  "company_status",
  "company_name",
  "registered_office_postcode",
  "sic_codes",
  "officers_active",
  "incorporation_date",
  "accounts_category",
]);

export async function runBlindVerifier(
  storage: Storage,
  ctx: VerificationContext,
  client: CompaniesHouseClient,
  ch: CompaniesHouseConfig,
  cfg: ProductsConfig["blind_verifier"],
  o: { day?: string; maxCompanies?: number } = {},
) {
  const day = o.day ?? new Date().toISOString().slice(0, 10);
  const facts = (
    await storage.facts.listCurrent({ status: "verified", limit: 1_000_000, offset: 0 })
  ).rows.filter((f) => CH_FIELDS.has(f.field));
  const rates = new Map<string, number>();
  const picked: typeof facts = [];
  for (const f of facts) {
    const key = `companies_house|${f.field}`;
    if (!rates.has(key))
      rates.set(
        key,
        adaptiveRate(await storage.blind.recent("companies_house", f.field, cfg.window), cfg),
      );
    if (await sampled(f.entity_id, f.field, day, rates.get(key) as number)) picked.push(f);
  }
  const byEntity = new Map<string, typeof facts>();
  for (const f of picked) byEntity.set(f.entity_id, [...(byEntity.get(f.entity_id) ?? []), f]);
  const entities = [...byEntity.keys()].slice(0, o.maxCompanies ?? 200);
  let checked = 0;
  let disagreements = 0;
  for (const id of entities) {
    // Fresh fetch, no cache, and no access to our stored claims.
    const bundle = await fetchCompanyBundle(client, id, ch);
    const fresh = (await mapCompanyBundle(bundle, crypto.randomUUID(), ch)).claims;
    for (const f of byEntity.get(id) ?? []) {
      const latest = fresh
        .filter((c) => c.field === f.field)
        .sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
      const def = ctx.registry.get(f.field);
      const ok =
        latest !== undefined && def !== undefined && agree(latest.value, f.value, def.tolerance);
      await storage.blind.add({
        entity_id: id,
        field: f.field,
        source: "companies_house",
        fact_value: f.value,
        fresh_value: latest?.value ?? null,
        agree: ok,
      });
      checked++;
      if (!ok) {
        disagreements++;
        await requestVerification(storage, {
          entities: [id],
          fields: [f.field],
          reason: "blind verifier disagreement",
        });
        await storage.alerts.raise(
          "blind_disagreement",
          `${id}.${f.field}: we serve ${JSON.stringify(f.value).slice(0, 80)}, the source now says ${JSON.stringify(latest?.value ?? null).slice(0, 80)}`,
          {},
        );
      }
    }
  }
  for (const [k, r] of rates)
    await storage.controls.set(rateKey(...(k.split("|") as [string, string])), r, "blind_verifier");
  return {
    sampled_facts: picked.length,
    companies: entities.length,
    checked,
    disagreements,
    rates: Object.fromEntries(rates),
  };
}
