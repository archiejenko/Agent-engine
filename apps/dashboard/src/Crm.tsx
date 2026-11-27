import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { Company } from "./Company.tsx";
import { Facts } from "./Facts.tsx";
import { EmptyRow, label } from "./format.tsx";
import { Golden } from "./Golden.tsx";
import { PagePanels } from "./pagePanels.tsx";

const STAGES = [
  "new",
  "contacted",
  "engaged",
  "replied",
  "claimed",
  "customer",
  "lost",
  "opted_out",
];
interface Row {
  entity_id: string;
  name: string;
  stage: string;
  expected_value_gbp: number | null;
  value_kind: "real" | "estimated" | null;
  last_contact: string | null;
  next_step: string;
  owner_agent: string | null;
  synthetic: boolean;
}
interface ListData {
  total: number;
  counts: Record<string, number>;
  rows: Row[];
}
const stageName = (s: string) => (s === "opted_out" ? "opted out" : s);
const gbp = (n: number | null) => (n === null ? "–" : `£${Math.round(n).toLocaleString("en-GB")}`);

function CompanyList() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [sim, setSim] = useState(false);
  const [d, setD] = useState<ListData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = new URLSearchParams({
    ...(search ? { search } : {}),
    ...(stage ? { stage } : {}),
    ...(sim ? { synthetic: "1" } : {}),
  });
  const qs = q.toString();
  useEffect(() => {
    getJson<ListData>(`/api/crm?${qs}`).then(setD, (e: Error) => setError(e.message));
  }, [qs]);
  return (
    <>
      <div className="filters">
        <input
          type="search"
          placeholder="Name or company number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search companies"
        />
        <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Stage">
          <option value="">every stage</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {stageName(s)} ({d?.counts[s] ?? 0})
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={sim} onChange={(e) => setSim(e.target.checked)} /> Include
          simulated
        </label>
        <a href={`/api/crm.csv?${qs}`}>Export CSV</a>
      </div>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <table>
        <thead>
          <tr>
            <th align="left">Company</th>
            <th align="left">Stage</th>
            <th>Value</th>
            <th align="left">Last contact</th>
            <th align="left">Next step</th>
          </tr>
        </thead>
        <tbody>
          {d && d.rows.length === 0 && <EmptyRow cols={5}>No companies match.</EmptyRow>}
          {d?.rows.map((r) => (
            <tr key={r.entity_id}>
              <td>
                <a href={`#/crm/${r.entity_id}`}>{r.name}</a>
                {r.synthetic && <span className="kind kind-synthetic">SIMULATED</span>}
              </td>
              <td>{stageName(r.stage)}</td>
              <td align="right">
                {gbp(r.expected_value_gbp)} {r.value_kind === "estimated" && <small>est.</small>}
              </td>
              <td>{r.last_contact?.slice(0, 10) ?? "never"}</td>
              <td>
                {r.next_step}
                {r.owner_agent && <small className="muted"> · {r.owner_agent}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {d && d.total > d.rows.length && (
        <p className="muted">
          Showing {d.rows.length} of {d.total}. Narrow the search to see more.
        </p>
      )}
    </>
  );
}

interface CompanyHistory {
  row: Row | null;
  opted_out: boolean;
  contacts: {
    id: string;
    channel: string;
    to: string;
    subject: string;
    status: string;
    reason: string | null;
    at: string;
  }[];
  ledger: {
    id: number;
    event: string;
    value_gbp: number | null;
    value_kind: string;
    observed_at: string;
    source: string;
    dry_run: boolean;
    synthetic: boolean;
  }[];
  tasks: {
    task_id: string;
    playbook: string;
    status: string;
    cost_gbp: number;
    revenue_gbp: number;
    updated_at: string;
  }[];
  claims: {
    id: string;
    status: string;
    monthly_gbp: number;
    setup_fee_gbp: number;
    updated_at: string;
  }[];
}

function CompanyView({ id }: { id: string }) {
  const [h, setH] = useState<CompanyHistory | null>(null);
  useEffect(() => {
    getJson<CompanyHistory>(`/api/crm/${id}?synthetic=1`).then(setH, () => setH(null));
  }, [id]);
  return (
    <>
      <p>
        <a href="#/crm">← All companies</a>
      </p>
      {h && (
        <>
          <h2>
            {h.row?.name ?? id} <small className="muted">{id}</small>
          </h2>
          <p>
            Stage: <b>{stageName(h.row?.stage ?? "new")}</b> · Next step: {h.row?.next_step ?? "–"}
            {h.opted_out && <b style={{ color: "crimson" }}> · Opted out: never contact</b>}
          </p>
          <h3>Contacts</h3>
          <table>
            <tbody>
              {h.contacts.length === 0 && <EmptyRow cols={4}>No contact yet.</EmptyRow>}
              {h.contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.at.slice(0, 10)}</td>
                  <td>{c.channel}</td>
                  <td>{c.subject}</td>
                  <td>
                    {c.status}
                    {c.reason && <small className="muted"> · {c.reason}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Outcome ledger</h3>
          <table>
            <tbody>
              {h.ledger.length === 0 && <EmptyRow cols={4}>No events yet.</EmptyRow>}
              {h.ledger.map((r) => (
                <tr key={r.id}>
                  <td>{r.observed_at.slice(0, 10)}</td>
                  <td>{label(r.event)}</td>
                  <td align="right">
                    {r.value_gbp === null ? "" : `£${r.value_gbp.toFixed(2)}`}
                    {r.value_kind === "estimate" && <small> est.</small>}
                  </td>
                  <td>
                    {r.source}
                    {r.dry_run && <span className="kind kind-dry_run">dry run</span>}
                    {r.synthetic && <span className="kind kind-synthetic">SIMULATED</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {h.claims.length > 0 && (
            <>
              <h3>Claimed site</h3>
              {h.claims.map((c) => (
                <p key={c.id}>
                  {c.status} · £{c.setup_fee_gbp} + £{c.monthly_gbp}/month ·{" "}
                  {c.updated_at.slice(0, 10)}
                </p>
              ))}
            </>
          )}
          <h3>Work</h3>
          <table>
            <tbody>
              {h.tasks.length === 0 && <EmptyRow cols={4}>No tasks.</EmptyRow>}
              {h.tasks.map((t) => (
                <tr key={t.task_id}>
                  <td>{t.playbook}</td>
                  <td>{t.status}</td>
                  <td align="right">£{t.cost_gbp.toFixed(3)} cost</td>
                  <td>{t.updated_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h3>Verified facts</h3>
      <Company id={id} />
    </>
  );
}

/** CRM: every company we've touched, its stage and full history; plus the facts browser and Verify. */
/** Companies: the pipeline board (default) or today's table; the choice lives in the address. */
const viewOf = (route: string): "board" | "table" =>
  new URLSearchParams(route.split("?")[1] ?? "").get("view") === "table" ? "table" : "board";

function Companies({ view }: { view: "board" | "table" }) {
  return (
    <>
      <nav className="tabs" aria-label="Companies view">
        <a href="#/crm" aria-current={view === "board" ? "page" : undefined}>
          Pipeline board
        </a>
        <a href="#/crm?view=table" aria-current={view === "table" ? "page" : undefined}>
          Table
        </a>
      </nav>
      {view === "table" ? (
        <CompanyList />
      ) : (
        <>
          <PagePanels page="crm" />
          <p>
            <a href="/api/crm.csv">Export CSV</a> · the table has search and stage filters.
          </p>
        </>
      )}
    </>
  );
}

export function Crm({ route }: { route: string }) {
  const id = route.match(/^\/crm\/([A-Za-z0-9]{8})/)?.[1]?.toUpperCase();
  if (id) return <CompanyView id={id} />;
  const tab = route.startsWith("/crm/facts")
    ? "facts"
    : route.startsWith("/crm/verify")
      ? "verify"
      : "companies";
  return (
    <>
      <h2>CRM</h2>
      <div className="tabs" role="tablist">
        {[
          ["companies", "#/crm", "Companies"],
          ["facts", "#/crm/facts", "Facts"],
          ["verify", "#/crm/verify", "Verify"],
        ].map(([k, href, name]) => (
          <a
            key={k}
            href={href}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "active" : undefined}
          >
            {name}
          </a>
        ))}
      </div>
      {tab === "facts" ? (
        <Facts />
      ) : tab === "verify" ? (
        <Golden />
      ) : (
        <Companies view={viewOf(route)} />
      )}
    </>
  );
}
