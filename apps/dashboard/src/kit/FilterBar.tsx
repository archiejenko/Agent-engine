import type { Filters } from "./filters.ts";

const PERIODS: [Filters["period"], string][] = [
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
  ["custom", "Custom"],
];

/**
 * Period presets, custom dates, playbook chips, compare toggle and the live/simulated switch. The
 * choice is stored in the URL hash (see filters.ts). With simulated rows on, the page gets a banner.
 */
export function FilterBar({
  value,
  onChange,
  playbooks,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  playbooks: string[];
}) {
  const set = (p: Partial<Filters>) => onChange({ ...value, ...p });
  return (
    <>
      <div className="filter-bar">
        <fieldset className="seg-control">
          <legend className="sr-only">Period</legend>
          {PERIODS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={value.period === k}
              className={value.period === k ? "on" : undefined}
              onClick={() =>
                set(
                  k === "custom"
                    ? { period: k, from: value.from ?? new Date().toISOString().slice(0, 10) }
                    : { period: k, from: null, to: null },
                )
              }
            >
              {label}
            </button>
          ))}
        </fieldset>
        {value.period === "custom" && (
          <span className="filter-dates">
            <input
              type="date"
              aria-label="From"
              value={value.from ?? ""}
              onChange={(e) => set({ from: e.target.value || null })}
            />
            <input
              type="date"
              aria-label="To"
              value={value.to ?? ""}
              onChange={(e) => set({ to: e.target.value || null })}
            />
          </span>
        )}
        <fieldset className="chips">
          <legend className="sr-only">Playbook</legend>
          <button
            type="button"
            className={value.playbook === null ? "chip on" : "chip"}
            aria-pressed={value.playbook === null}
            onClick={() => set({ playbook: null })}
          >
            All
          </button>
          {playbooks.map((p) => (
            <button
              key={p}
              type="button"
              className={value.playbook === p ? "chip on" : "chip"}
              aria-pressed={value.playbook === p}
              onClick={() => set({ playbook: value.playbook === p ? null : p })}
            >
              {p.replace(/_/g, " ")}
            </button>
          ))}
        </fieldset>
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.compare}
            onChange={(e) => set({ compare: e.target.checked })}
          />{" "}
          Compare to previous
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={value.synthetic}
            onChange={(e) => set({ synthetic: e.target.checked })}
          />{" "}
          Include simulated
        </label>
      </div>
      {value.synthetic && (
        <p className="banner sim-banner" role="status">
          Simulated rows are included. They are labelled "simulated" and never count as real money.
        </p>
      )}
    </>
  );
}
