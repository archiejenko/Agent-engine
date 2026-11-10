import { useEffect } from "react";

/** Human-readable names for registry fields and universe decisions (falls back to "Sentence case"). */
const LABELS: Record<string, string> = {
  accounts_category: "Accounts category",
  accounts_next_due: "Accounts next due",
  accounts_overdue: "Accounts overdue",
  charges: "Charges (secured loans)",
  company_name: "Company name",
  company_status: "Company status",
  company_type: "Company type",
  confirmation_statement_next_due: "Confirmation statement next due",
  confirmation_statement_overdue: "Confirmation statement overdue",
  contact_email: "Contact email",
  employees_average: "Staff (average)",
  filing_events: "Recent filings",
  incorporation_date: "Incorporated",
  insolvency_flags: "Insolvency history",
  job_postings: "Jobs advertised",
  last_accounts_made_up_to: "Last accounts made up to",
  officer_appointments: "Officers (all)",
  officers_active: "Officers (current)",
  psc_active: "People with significant control (current)",
  psc_history: "People with significant control (history)",
  registered_office_address: "Registered office",
  registered_office_flags: "Registered office status",
  registered_office_lad: "Local authority (registered office)",
  registered_office_postcode: "Registered office postcode",
  sic_codes: "SIC codes (business activity)",
  trading_address_postcode: "Trading address postcode",
  website_company_number: "Company number on website",
  website_copyright_year: "Website copyright year",
  website_found: "Website found",
  website_https: "Website uses HTTPS",
  website_last_modified: "Website last updated",
  website_mobile_ready: "Website works on mobile",
  website_url: "Website",
  x402_checks_30d: "Paid checks by AI agents (30 days)",
  dissolution_date: "Dissolved",
  // Universe decisions (Overview)
  in_universe: "In the universe",
  in_universe_staff_unknown: "In the universe (staff number unknown)",
  staff_above_max: "Too many staff",
  staff_below_min: "Too few staff",
  sic_excluded: "Excluded activity (SIC)",
  dormant: "Dormant",
  status_dissolved: "Dissolved",
  status_liquidation: "In liquidation",
  outside_region: "Outside Greater Manchester",
};

export function label(key: string): string {
  if (LABELS[key]) return LABELS[key] as string;
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Obj = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const d10 = (v: unknown) => str(v).slice(0, 10);

/** Short readable lines for list-shaped values (officers, PSCs, filings, charges, jobs, SIC codes). */
export function valueLines(field: string, value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value as Obj[];
  if (field === "officer_appointments" || field === "officers_active")
    return items.map((o) =>
      [
        str(o.name),
        str(o.officer_role).replace(/-/g, " "),
        o.appointed_on ? `appointed ${d10(o.appointed_on)}` : "",
        o.resigned_on ? `resigned ${d10(o.resigned_on)}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    );
  if (field === "psc_active" || field === "psc_history")
    return items.map((p) =>
      [
        str(p.name),
        Array.isArray(p.natures_of_control)
          ? (p.natures_of_control as string[]).map((n) => n.replace(/-/g, " ")).join("; ")
          : "",
        p.notified_on ? `notified ${d10(p.notified_on)}` : "",
        p.ceased_on ? `ceased ${d10(p.ceased_on)}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    );
  if (field === "filing_events")
    return items.map((f) =>
      [d10(f.date), str(f.category), f.type ? `(${str(f.type)})` : ""].filter(Boolean).join(" "),
    );
  if (field === "charges")
    return items.map(
      (c) =>
        [
          c.created_on ? `created ${d10(c.created_on)}` : "",
          str(c.status),
          Array.isArray(c.persons_entitled)
            ? `to ${(c.persons_entitled as Obj[]).map((p) => str(p.name)).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(", ") || "charge",
    );
  return items.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/** One readable line for any other value. */
export function valueText(field: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (field === "registered_office_address" && typeof value === "object") {
    const a = value as Obj;
    return [
      a.care_of ? `c/o ${str(a.care_of)}` : "",
      a.premises,
      a.address_line_1,
      a.address_line_2,
      a.locality,
      a.region,
      a.postal_code,
    ]
      .map(str)
      .filter(Boolean)
      .join(", ");
  }
  if (field === "registered_office_flags" && typeof value === "object") {
    const f = value as Obj;
    return [
      f.undeliverable ? "undeliverable" : "deliverable",
      f.in_dispute ? "in dispute" : "not in dispute",
    ].join(", ");
  }
  if (field === "insolvency_flags" && typeof value === "object") {
    const on = Object.entries(value as Obj)
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/^has_/, "").replace(/_/g, " "));
    return on.length ? on.join(", ") : "none";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A fact value as people read it: a short list (max `max` items) or one line. */
export function FactValue({
  field,
  value,
  max = 3,
}: {
  field: string;
  value: unknown;
  max?: number;
}) {
  const lines = valueLines(field, value);
  if (!lines) return <>{valueText(field, value)}</>;
  if (!lines.length) return <span className="muted">none</span>;
  return (
    <ul className="facts-list">
      {lines.slice(0, max).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: display-only list in a fixed order.
        <li key={i}>{l}</li>
      ))}
      {lines.length > max && <li className="muted">and {lines.length - max} more</li>}
    </ul>
  );
}

/** A table-wide "nothing here" row. */
export function EmptyRow({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="empty">
        {children}
      </td>
    </tr>
  );
}

/**
 * Mobile tables: copies each column's header text onto its cells as data-label, so under 600px
 * (styles.css) each row becomes a card of "Label: value" lines. Runs after every render.
 */
export function useTableLabels() {
  useEffect(() => {
    const apply = () => {
      for (const table of document.querySelectorAll("table")) {
        const heads = [...table.querySelectorAll("thead th")].map(
          (th) => th.textContent?.trim() ?? "",
        );
        if (!heads.length) continue;
        for (const row of table.querySelectorAll("tbody tr")) {
          [...row.children].forEach((cell, i) => {
            const h = heads[i];
            if (
              h &&
              (cell as HTMLTableCellElement).colSpan === 1 &&
              cell.getAttribute("data-label") !== h
            )
              cell.setAttribute("data-label", h);
          });
        }
      }
    };
    apply();
    const obs = new MutationObserver(apply);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
}
