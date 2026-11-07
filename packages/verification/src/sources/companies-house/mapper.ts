import type { CompaniesHouseConfig } from "@ae/config";
import type { Claim } from "@ae/contracts";
import { canonicalJson, stableUuid } from "../../ids.ts";
import { normalisePostcode } from "../../resolve.ts";
import type { CompanyBundle } from "./client.ts";

/**
 * Turns one company's API responses into claims.
 *
 * published_at rule (approved by Archie): the date a Companies House fact became KNOWABLE is when the
 * filing was received/published, not when the change took effect. For each fact we look for the
 * filing that made it public; if we can't find one we fall back to the fetch time (conservative: we
 * never pretend to have known something earlier than we can prove). Fallbacks are counted.
 *
 * History fields (officers, filings, charges, PSC) are emitted as SNAPSHOTS: one claim per publication
 * date, holding the state as it was then, so point-in-time queries can see past states.
 *
 * Field names are from our reading of the CH API; every source key we don't map is logged as
 * dropped (never guessed). See docs/sources/companies-house.md for what to verify.
 */

export const SOURCE = "companies_house";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const s = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const date = (v: unknown): string | null => {
  const x = s(v);
  return x && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x)) ? x : null;
};
const at = (d: string) => `${d}T00:00:00Z`;

/** Profile keys we map, and keys we know about and deliberately ignore. Anything else is logged. */
const PROFILE_MAPPED = new Set([
  "company_name",
  "company_number",
  "company_status",
  "type",
  "date_of_creation",
  "date_of_cessation",
  "registered_office_address",
  "sic_codes",
  "accounts",
  "confirmation_statement",
  "has_insolvency_history",
  "has_been_liquidated",
  "has_charges",
  "undeliverable_registered_office_address",
  "registered_office_is_in_dispute",
  "previous_company_names",
]);
const PROFILE_IGNORED = new Set([
  "links",
  "etag",
  "kind",
  "can_file",
  "jurisdiction",
  "company_status_detail",
  "has_super_secure_pscs",
  "is_community_interest_company",
  "external_registration_number",
  "foreign_company_details",
  "branch_company_details",
  "annual_return",
  "last_full_members_list_date",
  "service_address",
  "subtype",
  "partial_data_available",
]);

interface Filing {
  date: string;
  action_date: string | null;
  category: string | null;
  type: string;
  transaction_id: string | null;
  dv: Obj;
}

export interface MapStats {
  claims: number;
  /** Facts whose publication date we couldn't find a filing for (fell back to fetch time). */
  published_fallbacks: Record<string, number>;
  dropped_source_fields: Record<string, number>;
}

export interface MapResult {
  claims: Claim[];
  stats: MapStats;
}

export async function mapCompanyBundle(
  bundle: CompanyBundle,
  runId: string,
  cfg: CompaniesHouseConfig,
): Promise<MapResult> {
  const stats: MapStats = { claims: 0, published_fallbacks: {}, dropped_source_fields: {} };
  const claims: Claim[] = [];
  const n = bundle.company_number;
  const P = bundle.fetched_at;
  const Pms = Date.parse(P);
  const profile = obj(bundle.profile);
  if (!bundle.profile) return { claims, stats };

  const name = s(profile.company_name);
  const created = date(profile.date_of_creation);
  const base = `${cfg.api_base_url}/company/${n}`;
  const fallback = (field: string) => {
    stats.published_fallbacks[field] = (stats.published_fallbacks[field] ?? 0) + 1;
    return P;
  };
  const clamp = (iso: string) => (Date.parse(iso) > Pms ? P : iso);

  async function add(
    field: string,
    value: Claim["value"],
    published: string,
    observed: string,
    path = "",
  ) {
    const pub = clamp(published);
    claims.push({
      claim_id: await stableUuid([SOURCE, n, field, pub, canonicalJson(value)]),
      entity_id: n,
      raw_entity_ref: { source_id: n, name },
      field,
      value,
      source: SOURCE,
      source_tier: 1,
      lane: "open",
      method: "api",
      evidence: { kind: "record", ref: `${base}${path}` },
      observed_at: clamp(observed),
      published_at: pub,
      fetched_at: P,
      run_id: runId,
    });
  }

  for (const k of Object.keys(profile)) {
    if (!PROFILE_MAPPED.has(k) && !PROFILE_IGNORED.has(k)) {
      stats.dropped_source_fields[`profile.${k}`] =
        (stats.dropped_source_fields[`profile.${k}`] ?? 0) + 1;
    }
  }

  // ---- Filing index: the evidence of WHEN things became public.
  const filings: Filing[] = arr(bundle.filings)
    .map((f) => ({
      date: date(f.date) ?? "",
      action_date: date(f.action_date),
      category: s(f.category),
      type: s(f.type) ?? "",
      transaction_id: s(f.transaction_id),
      dv: obj(f.description_values),
    }))
    .filter((f) => f.date !== "")
    .sort(
      (x, y) =>
        x.date.localeCompare(y.date) ||
        (x.transaction_id ?? "").localeCompare(y.transaction_id ?? ""),
    );

  const latestFiling = (pred: (f: Filing) => boolean) => [...filings].reverse().find(pred) ?? null;
  /** The earliest filing on/after the event date that mentions that date (action_date or a description value). */
  const filingFor = (types: RegExp, eventDate: string | null): string | null => {
    if (!eventDate) return null;
    const hit = filings.find(
      (f) =>
        types.test(f.type) &&
        f.date >= eventDate &&
        (f.action_date === eventDate || Object.values(f.dv).some((v) => v === eventDate)),
    );
    return hit ? at(hit.date) : null;
  };
  const createdAt = created ? at(created) : null;

  // ---- Profile facts (the register asserts these now: observed = fetch time).
  const status = s(profile.company_status);
  const insolvent = profile.has_insolvency_history === true || profile.has_been_liquidated === true;
  const cessation = date(profile.date_of_cessation);

  if (name) {
    const prev = arr(profile.previous_company_names);
    const nameFiling = latestFiling(
      (f) => f.category === "change-of-name" || /^(NM01|NM04|CONNOT|CERTNM)/.test(f.type),
    );
    const pub = prev.length === 0 ? createdAt : nameFiling ? at(nameFiling.date) : null;
    await add("company_name", name, pub ?? fallback("company_name"), P);
  }
  if (status) {
    let pub: string | null = null;
    if (status === "active" && !insolvent) pub = createdAt; // active since incorporation (see known biases)
    if (status === "dissolved" && cessation) pub = at(cessation);
    await add("company_status", status, pub ?? fallback("company_status"), P);
  }
  const type = s(profile.type);
  if (type) await add("company_type", type, createdAt ?? fallback("company_type"), P);
  if (created) await add("incorporation_date", created, at(created), at(created));
  if (cessation) await add("dissolution_date", cessation, at(cessation), at(cessation));

  const roa = obj(profile.registered_office_address);
  const address: Obj = {};
  for (const k of [
    "care_of",
    "po_box",
    "premises",
    "address_line_1",
    "address_line_2",
    "locality",
    "region",
    "postal_code",
    "country",
  ]) {
    const v = s(roa[k]);
    if (v) address[k] = v;
  }
  if (Object.keys(address).length) {
    const ad01 = latestFiling((f) => /^AD01/.test(f.type));
    const pub = ad01 ? at(ad01.date) : createdAt;
    const p = pub ?? fallback("registered_office_address");
    await add("registered_office_address", address as Claim["value"], p, P);
    const pc = normalisePostcode(s(roa.postal_code));
    if (pc) await add("registered_office_postcode", pc, p, P);
  }
  const flags: Obj = {};
  if (b(profile.undeliverable_registered_office_address) !== null)
    flags.undeliverable = profile.undeliverable_registered_office_address;
  if (b(profile.registered_office_is_in_dispute) !== null)
    flags.in_dispute = profile.registered_office_is_in_dispute;
  if (Object.keys(flags).length)
    await add("registered_office_flags", flags as Claim["value"], P, P);

  const sic = Array.isArray(profile.sic_codes)
    ? profile.sic_codes.filter((x): x is string => typeof x === "string").sort()
    : [];
  if (sic.length) {
    const cs = latestFiling((f) => /^(CS01|AR01|NEWINC|IN01)/.test(f.type));
    await add("sic_codes", sic, cs ? at(cs.date) : fallback("sic_codes"), P);
  }

  const accounts = obj(profile.accounts);
  const last = obj(accounts.last_accounts);
  const madeUp = date(last.made_up_to);
  const accType = s(last.type);
  if (madeUp || accType) {
    const aa =
      filings.find((f) => f.category === "accounts" && Object.values(f.dv).includes(madeUp)) ??
      (madeUp ? filings.find((f) => f.category === "accounts" && f.date >= madeUp) : undefined);
    const pub = aa ? at(aa.date) : fallback("last_accounts");
    if (madeUp) await add("last_accounts_made_up_to", madeUp, pub, at(madeUp), "");
    if (accType) await add("accounts_category", accType, pub, madeUp ? at(madeUp) : P);
  }
  const nextDue = date(accounts.next_due);
  if (nextDue) await add("accounts_next_due", nextDue, P, P);
  if (b(accounts.overdue) !== null)
    await add("accounts_overdue", accounts.overdue as boolean, P, P);
  const cs = obj(profile.confirmation_statement);
  if (date(cs.next_due))
    await add("confirmation_statement_next_due", date(cs.next_due) as string, P, P);
  if (b(cs.overdue) !== null)
    await add("confirmation_statement_overdue", cs.overdue as boolean, P, P);

  const ins: Obj = {};
  for (const k of ["has_insolvency_history", "has_been_liquidated", "has_charges"])
    if (b(profile[k]) !== null) ins[k] = profile[k];
  if (Object.keys(ins).length) await add("insolvency_flags", ins as Claim["value"], P, P);

  // ---- History fields as snapshots.
  const yearMs = 365.25 * 86_400_000;
  const windowStart = new Date(Pms - cfg.history_years * yearMs).toISOString();
  const filingWindowStart = new Date(Pms - cfg.filing_history_years * yearMs).toISOString();

  /** Publication points: all inside the window, plus the last one before it (state entering the window). */
  const points = (dates: string[], start: string) => {
    const uniq = [...new Set(dates)].sort();
    const before = uniq.filter((d) => d < start);
    return [
      ...(before.length ? [before[before.length - 1] as string] : []),
      ...uniq.filter((d) => d >= start),
    ];
  };
  async function snapshots(
    field: string,
    pts: string[],
    stateAt: (p: string) => Claim["value"],
    path: string,
  ) {
    let prev: string | null = null;
    for (const p of pts) {
      const value = stateAt(p);
      const key = canonicalJson(value);
      if (key === prev) continue;
      prev = key;
      await add(field, value, p, p, path);
    }
  }

  // Officers
  const officerEvents = arr(bundle.officers).map((o) => {
    const appointed = date(o.appointed_on);
    const resigned = date(o.resigned_on);
    const appointedPub =
      filingFor(/^(AP0[1-4]|NEWINC|IN01)/, appointed) ??
      (appointed && appointed === created && createdAt ? createdAt : null) ??
      (appointed
        ? fallback("officer_appointment")
        : (createdAt ?? fallback("officer_appointment")));
    const resignedPub = resigned
      ? (filingFor(/^(TM0[12])/, resigned) ?? fallback("officer_resignation"))
      : null;
    const dob = obj(o.date_of_birth);
    return {
      name: s(o.name) ?? "UNKNOWN",
      officer_role: s(o.officer_role) ?? "unknown",
      appointed_on: appointed,
      resigned_on: resigned,
      date_of_birth: dob.year ? { month: Number(dob.month) || null, year: Number(dob.year) } : null,
      appointedPub: clamp(appointedPub),
      resignedPub: resignedPub ? clamp(resignedPub) : null,
    };
  });
  const officerPts = points(
    officerEvents.flatMap((e) => [e.appointedPub, ...(e.resignedPub ? [e.resignedPub] : [])]),
    windowStart,
  );
  const byOfficer = (
    x: { name: string; appointed_on: string | null; officer_role: string },
    y: typeof x,
  ) =>
    x.name.localeCompare(y.name) ||
    (x.appointed_on ?? "").localeCompare(y.appointed_on ?? "") ||
    x.officer_role.localeCompare(y.officer_role);
  await snapshots(
    "officers_active",
    officerPts,
    (p) =>
      officerEvents
        .filter((e) => e.appointedPub <= p && !(e.resignedPub && e.resignedPub <= p))
        .sort(byOfficer)
        .map((e) => ({
          name: e.name,
          officer_role: e.officer_role,
          appointed_on: e.appointed_on,
          date_of_birth: e.date_of_birth,
        })),
    "/officers",
  );
  await snapshots(
    "officer_appointments",
    officerPts,
    (p) =>
      officerEvents
        .filter((e) => e.appointedPub <= p)
        .filter(
          (e) =>
            !(e.resignedPub && e.resignedPub <= p) ||
            (e.resigned_on ?? "") >= windowStart.slice(0, 10),
        )
        .sort(byOfficer)
        .map((e) => ({
          name: e.name,
          officer_role: e.officer_role,
          appointed_on: e.appointed_on,
          resigned_on: e.resignedPub && e.resignedPub <= p ? e.resigned_on : null,
        })),
    "/officers",
  );

  // Filing history (shorter window: it's the bulkiest field)
  const filingPts = points(
    filings.map((f) => at(f.date)),
    filingWindowStart,
  );
  await snapshots(
    "filing_events",
    filingPts,
    (p) =>
      filings
        .filter((f) => at(f.date) <= p && at(f.date) >= filingWindowStart)
        .map((f) => ({
          date: f.date,
          action_date: f.action_date,
          category: f.category,
          type: f.type,
        })),
    "/filing-history",
  );

  // Charges
  const chargeEvents = arr(bundle.charges).map((c) => {
    const createdOn = date(c.created_on);
    const delivered = date(c.delivered_on);
    const satisfied = date(c.satisfied_on);
    const createdPub = delivered
      ? at(delivered)
      : (filingFor(/^MR01/, createdOn) ?? fallback("charge_created"));
    const satisfiedPub = satisfied ? (filingFor(/^MR04/, satisfied) ?? at(satisfied)) : null;
    return {
      id: s(c.charge_code) ?? String(c.charge_number ?? "unknown"),
      created_on: createdOn,
      delivered_on: delivered,
      raw_status: s(c.status) ?? "unknown",
      satisfied_on: satisfied,
      createdPub: clamp(createdPub),
      satisfiedPub: satisfiedPub ? clamp(satisfiedPub) : null,
    };
  });
  await snapshots(
    "charges",
    points(
      chargeEvents.flatMap((c) => [c.createdPub, ...(c.satisfiedPub ? [c.satisfiedPub] : [])]),
      windowStart,
    ),
    (p) =>
      chargeEvents
        .filter((c) => c.createdPub <= p)
        .sort(
          (x, y) =>
            (x.created_on ?? "").localeCompare(y.created_on ?? "") || x.id.localeCompare(y.id),
        )
        .map((c) => {
          const satisfiedNow = c.satisfiedPub !== null && c.satisfiedPub <= p;
          return {
            id: c.id,
            created_on: c.created_on,
            delivered_on: c.delivered_on,
            // Until the satisfaction is public, the charge was (as far as anyone could know) outstanding.
            status: satisfiedNow ? c.raw_status : "outstanding",
            satisfied_on: satisfiedNow ? c.satisfied_on : null,
          };
        }),
    "/charges",
  );

  // Persons with significant control
  const pscEvents = arr(bundle.psc).map((x) => {
    const notified = date(x.notified_on);
    const ceased = date(x.ceased_on);
    const notifiedPub =
      filingFor(/^(PSC0[1-9]|NEWINC|IN01)/, notified) ??
      (notified && notified === created && createdAt ? createdAt : null) ??
      fallback("psc_notified");
    const ceasedPub = ceased ? (filingFor(/^PSC0[7-9]/, ceased) ?? fallback("psc_ceased")) : null;
    return {
      name: s(x.name) ?? "UNKNOWN",
      kind: s(x.kind) ?? "unknown",
      natures_of_control: Array.isArray(x.natures_of_control)
        ? x.natures_of_control.filter((v): v is string => typeof v === "string").sort()
        : [],
      notified_on: notified,
      ceased_on: ceased,
      notifiedPub: clamp(notifiedPub),
      ceasedPub: ceasedPub ? clamp(ceasedPub) : null,
    };
  });
  const pscPts = points(
    pscEvents.flatMap((e) => [e.notifiedPub, ...(e.ceasedPub ? [e.ceasedPub] : [])]),
    windowStart,
  );
  const byPsc = (x: { name: string; notified_on: string | null }, y: typeof x) =>
    x.name.localeCompare(y.name) || (x.notified_on ?? "").localeCompare(y.notified_on ?? "");
  await snapshots(
    "psc_active",
    pscPts,
    (p) =>
      pscEvents
        .filter((e) => e.notifiedPub <= p && !(e.ceasedPub && e.ceasedPub <= p))
        .sort(byPsc)
        .map((e) => ({
          name: e.name,
          kind: e.kind,
          natures_of_control: e.natures_of_control,
          notified_on: e.notified_on,
        })),
    "/persons-with-significant-control",
  );
  await snapshots(
    "psc_history",
    pscPts,
    (p) =>
      pscEvents
        .filter((e) => e.notifiedPub <= p)
        .sort(byPsc)
        .map((e) => ({
          name: e.name,
          kind: e.kind,
          notified_on: e.notified_on,
          ceased_on: e.ceasedPub && e.ceasedPub <= p ? e.ceased_on : null,
        })),
    "/persons-with-significant-control",
  );

  stats.claims = claims.length;
  return { claims, stats };
}
