import { Letters } from "./Letters.tsx";
import { NeedsYou } from "./NeedsYou.tsx";

/** Inbox (v3): outbound drafts, sent mail, replies and letters. Phase 3 completes it. */
export function Inbox({ route }: { route: string }) {
  const tab = route.startsWith("/inbox/letters") ? "letters" : "drafts";
  return (
    <>
      <h2>Inbox</h2>
      <div className="tabs" role="tablist">
        <a
          href="#/inbox"
          role="tab"
          aria-selected={tab === "drafts"}
          className={tab === "drafts" ? "active" : undefined}
        >
          Drafts
        </a>
        <a
          href="#/inbox/letters"
          role="tab"
          aria-selected={tab === "letters"}
          className={tab === "letters" ? "active" : undefined}
        >
          Letters
        </a>
      </div>
      {tab === "letters" ? <Letters /> : <NeedsYou type="draft" title="Drafts awaiting approval" />}
    </>
  );
}
