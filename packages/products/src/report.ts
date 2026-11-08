import type { CompanyCheck } from "./check.ts";

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v))
    return v.length
      ? v
          .map((x) =>
            typeof x === "object" && x
              ? Object.values(x)
                  .filter((y) => typeof y === "string")
                  .join(", ")
              : String(x),
          )
          .join("; ")
      : "None";
  if (typeof v === "object")
    return Object.entries(v)
      .map(([k, x]) => `${k.replace(/_/g, " ")}: ${show(x)}`)
      .join(", ");
  return String(v);
}

/** One-page HTML report, rendered deterministically from the check (no model involved). */
export function renderReport(c: CompanyCheck): string {
  const name =
    typeof c.fields.company_name?.value === "string"
      ? c.fields.company_name.value
      : c.company_number;
  const rows = Object.entries(c.fields)
    .map(
      ([k, f]) =>
        `<tr><td>${esc(k.replace(/_/g, " "))}</td><td>${esc(show(f.value))}</td><td>${(f.confidence * 100).toFixed(0)}%</td><td>${esc(f.last_verified_at.slice(0, 10))}</td></tr>`,
    )
    .join("");
  const flags = c.risk_flags.length
    ? `<ul>${c.risk_flags.map((r) => `<li><b>${esc(r.flag.replace(/_/g, " "))}</b>: ${esc(r.detail)}</li>`).join("")}</ul>`
    : "<p>No risk flags found.</p>";
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(name)} — company check</title></head><body style="font-family:system-ui,sans-serif;max-width:760px;margin:2rem auto">
<h1>${esc(name)} <small>${esc(c.company_number)}</small></h1>
<p>Checked ${esc(c.as_of.slice(0, 16).replace("T", " "))} UTC.</p>
<h2>Things to know</h2>${flags}
<h2>Details</h2><table cellpadding="4"><tr><th align="left">Item</th><th align="left">Value</th><th>Confidence</th><th>Last verified</th></tr>${rows}</table>
<p style="color:#666;font-size:0.85em">${esc(c.disclaimer)}</p></body></html>`;
}
