import type { PanelRow } from "@ae/contracts";

/** One line of status chips; each opens the page that fixes it. */
export function HealthStrip({ rows }: { rows: PanelRow[] }) {
  return (
    <ul className="health-strip">
      {rows.map((r) => (
        <li key={r.key} className={`chip ${r.status ?? "info"}`} title={r.detail ?? undefined}>
          <span className={`dot ${r.status ?? "info"}`} aria-hidden="true" />
          {r.drill ? <a href={`#${r.drill}`}>{r.label}</a> : r.label}
        </li>
      ))}
    </ul>
  );
}
