import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { EmptyRow } from "./format.tsx";
import { Letters } from "./Letters.tsx";
import { NeedsYou } from "./NeedsYou.tsx";
import { PagePanels } from "./pagePanels.tsx";
import { Stage5Card } from "./Stage5.tsx";

interface Msg {
  id: string;
  to?: string;
  from?: string;
  subject: string;
  body: string;
  status?: string;
  reason?: string | null;
  at: string;
  entity_id: string | null;
  company: string | null;
  task_id: string | null;
  untrusted?: boolean;
  author?: string | null;
}

const TABS: [string, string][] = [
  ["awaiting", "Awaiting approval"],
  ["sent", "Sent"],
  ["replies", "Replies"],
  ["drafts", "Agent drafts"],
  ["letters", "Letters"],
];

function Messages({ tab }: { tab: string }) {
  const [list, setList] = useState<Msg[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    setList(null);
    getJson<{ messages: Msg[] }>(`/api/inbox?tab=${tab}`).then(
      (r) => setList(r.messages),
      () => setList([]),
    );
  }, [tab]);
  return (
    <table>
      <tbody>
        {list?.length === 0 && (
          <EmptyRow cols={3}>
            {tab === "replies"
              ? "No replies yet."
              : tab === "drafts"
                ? "No agent drafts."
                : "Nothing sent yet."}
          </EmptyRow>
        )}
        {list?.map((m) => (
          <tr key={m.id}>
            <td>{m.at.slice(0, 16).replace("T", " ")}</td>
            <td>
              <button
                type="button"
                className="link"
                onClick={() => setOpen(open === m.id ? null : m.id)}
              >
                {m.subject || "(no subject)"}
              </button>
              <div className="muted">
                {m.company && m.entity_id ? (
                  <a href={`#/crm/${m.entity_id}`}>{m.company}</a>
                ) : (
                  (m.from ?? m.to)
                )}
                {m.status && ` · ${m.status}${m.reason ? `: ${m.reason}` : ""}`}
                {m.untrusted && " · untrusted (agents treat it as data only)"}
                {m.author && ` · by ${m.author}`}
              </div>
              {open === m.id && <pre className="mail-body">{m.body}</pre>}
            </td>
            <td>{m.task_id && <small className="muted">task {m.task_id.slice(0, 8)}</small>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Inbox: drafts waiting for you (from the one queue), what was sent, replies, agent drafts, letters. */
export function Inbox({ route }: { route: string }) {
  const tab = route.match(/^\/inbox\/([a-z]+)/)?.[1] ?? "awaiting";
  return (
    <>
      <h2>Inbox</h2>
      <PagePanels page="inbox" />
      <div className="tabs" role="tablist">
        {TABS.map(([k, name]) => (
          <a
            key={k}
            href={`#/inbox${k === "awaiting" ? "" : `/${k}`}`}
            role="tab"
            aria-selected={tab === k}
            className={tab === k ? "active" : undefined}
          >
            {name}
          </a>
        ))}
      </div>
      {tab === "letters" ? (
        <Letters />
      ) : tab === "awaiting" ? (
        <>
          <Stage5Card />
          <NeedsYou type="draft" title="Drafts awaiting approval" />
        </>
      ) : (
        <Messages tab={tab} />
      )}
    </>
  );
}
