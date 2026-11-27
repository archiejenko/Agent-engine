import { FilterBar } from "./FilterBar.tsx";
import { useFilters } from "./filters.ts";
import { pageLayout } from "./layout.ts";
import { LivePanel } from "./render.tsx";

/** The playbooks the filter bar offers (the same list the old Home's selector had). */
const PLAYBOOKS = ["sme_outreach", "sme_letter", "post_reply", "claim_site"];

const home = pageLayout("home");

/**
 * The Home cockpit (cockpit UI plan §4), drawn from home.json: filter bar and live/simulated badge,
 * then each section's panels in the layout's order. Every panel loads, refreshes and fails on its own.
 */
export function Cockpit() {
  const [filters, setFilters] = useFilters();
  return (
    <div className="cockpit">
      <div className="cockpit-head">
        <span className={`data-badge ${filters.synthetic ? "sim" : "live"}`} role="status">
          {filters.synthetic ? "Live + simulated data" : "Live data only"}
        </span>
        {home.fallback && (
          <span className="muted" role="alert">
            The Home layout file was refused, so a simple built-in layout is shown.
          </span>
        )}
      </div>
      <FilterBar value={filters} onChange={setFilters} playbooks={PLAYBOOKS} />
      {home.layout.sections.map((s) => (
        <section key={s.id} className="cockpit-section" aria-label={s.title ?? s.id}>
          {s.title && <h2 className="cockpit-title">{s.title}</h2>}
          <div className="panel-grid">
            {s.panels.map((p) => (
              <LivePanel key={p.id} spec={p} filters={filters} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Every figure the old Home tiles showed (sends, sales, lift, review minutes too): the Quality tab. */
export function AllFigures() {
  const [filters] = useFilters();
  return (
    <div className="panel-grid">
      <LivePanel
        filters={filters}
        spec={{
          id: "all_figures",
          title: "All figures",
          component: "Kpi",
          query: "kpis",
          args: {},
          span: 4,
          refresh_s: 0,
          drill: null,
        }}
      />
    </div>
  );
}
