import type { DraftInput, InboundEmail, Inbox, MailboxPort } from "@ae/ports";
import { parseRawEmail, replyTokenOf } from "@ae/ports";
import type { Storage } from "@ae/storage";
import type { ToolRegistry } from "./tools.ts";

/**
 * The outreach mailbox (v3 Phase 3). One dedicated address on the sending domain (decision D1), stored in
 * `mail_messages`. Agents get three tools: list, read, draft. There is NO send, delete or forward tool
 * here or on the MCP endpoint; sending stays the `send_email` tool behind approval (rule 18).
 */
export function storageMailbox(
  storage: Storage,
  o: { includeSynthetic?: boolean } = {},
): MailboxPort {
  const summary = (m: Awaited<ReturnType<Storage["mail"]["get"]>> & object) => ({
    id: m.id,
    folder: m.folder,
    from: m.from,
    to: m.to,
    subject: m.subject,
    received_at: m.received_at,
    entity_id: m.entity_id,
    task_id: m.task_id,
    in_reply_to: m.in_reply_to,
  });
  return {
    list: async (q) =>
      (
        await storage.mail.list({
          folder: q.folder,
          limit: Math.min(q.limit, 200),
          ...(q.since ? { since: q.since } : {}),
          includeSynthetic: o.includeSynthetic ?? true,
        })
      ).map(summary),
    read: async (id) => {
      const m = await storage.mail.get(id);
      return m ? { ...summary(m), body: m.body, untrusted: m.untrusted } : null;
    },
    createDraft: async (d: DraftInput) => {
      const id = crypto.randomUUID();
      await storage.mail.add({
        id,
        folder: "drafts",
        from: "",
        to: d.to,
        subject: d.subject,
        body: d.body,
        in_reply_to: d.in_reply_to ?? null,
        entity_id: d.entity_id ?? null,
        task_id: d.task_id ?? null,
        untrusted: false,
        author: d.author,
        received_at: new Date().toISOString(),
      });
      return { id };
    },
  };
}

/** Stores one inbound email (Cloudflare Email Routing, or the local fake inbox). Untrusted. */
export async function receiveEmail(
  storage: Storage,
  m: {
    id: string;
    from: string;
    to: string;
    subject: string;
    body: string;
    received_at: string;
    in_reply_to?: string | null;
  },
) {
  const replyTo = m.in_reply_to ?? replyTokenOf(m.to);
  const original = replyTo ? await storage.outbox.get(replyTo) : null;
  await storage.mail.add({
    id: m.id,
    folder: "inbox",
    from: m.from,
    to: m.to,
    subject: m.subject.slice(0, 500),
    body: m.body.slice(0, 50_000),
    in_reply_to: original ? original.id : null,
    entity_id: original?.entity_id ?? null,
    task_id: original?.task_id ?? null,
    untrusted: true,
    received_at: m.received_at,
  });
  return original?.id ?? null;
}

/** For the Worker's email() handler: raw RFC 5322 text → a stored inbox message. */
export async function receiveRawEmail(
  storage: Storage,
  e: { from: string; to: string; raw: string; receivedAt?: string },
) {
  const { headers, text } = parseRawEmail(e.raw);
  const id = (headers["message-id"] ?? crypto.randomUUID()).replace(/[<>]/g, "").slice(0, 200);
  return receiveEmail(storage, {
    id,
    from: e.from,
    to: e.to,
    subject: headers.subject ?? "",
    body: text,
    received_at: e.receivedAt ?? new Date().toISOString(),
  });
}

/** The mailbox as the reply loop's Inbox (Workers): messages received since a time. */
export function mailboxInbox(storage: Storage): Inbox {
  return {
    poll: async (since: string): Promise<InboundEmail[]> =>
      (await storage.mail.list({ folder: "inbox", limit: 500, since }))
        .filter((m) => m.received_at > since)
        .map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          body: m.body,
          received_at: m.received_at,
          in_reply_to: m.in_reply_to,
        })),
  };
}

/** The three mailbox tools agents may use. None of them sends anything. */
export const MAILBOX_TOOLS = ["mailbox_list", "mailbox_read", "mailbox_draft"] as const;

export function registerMailboxTools(registry: ToolRegistry, deps: { mailbox: MailboxPort }) {
  const base = {
    allowed_lanes: ["open" as const],
    external: false,
    serves_customer: false,
    rate_limit_per_min: 120,
    cost_gbp_per_call: 0,
  };
  registry.register(
    {
      ...base,
      name: "mailbox_list",
      description: "List mailbox messages (inbox or drafts).",
      allowed_roles: ["researcher", "writer", "checker"],
    },
    async (args) => {
      const a = args as { folder?: "inbox" | "drafts"; limit?: number };
      return {
        result: await deps.mailbox.list({ folder: a.folder ?? "inbox", limit: a.limit ?? 20 }),
      };
    },
  );
  registry.register(
    // Reading returns untrusted content: the runner keeps it out of logs and away from the operator.
    {
      ...base,
      name: "mailbox_read",
      description: "Read one mailbox message (untrusted content).",
      allowed_roles: ["researcher", "writer", "checker"],
    },
    async (args) => ({
      result: await deps.mailbox.read((args as { id: string }).id),
      untrusted: true,
    }),
  );
  registry.register(
    {
      ...base,
      name: "mailbox_draft",
      description: "Save a draft in the mailbox (never sends).",
      allowed_roles: ["writer"],
    },
    async (args, { task }) => {
      const a = args as DraftInput;
      return {
        result: await deps.mailbox.createDraft({
          ...a,
          task_id: task.task_id,
          author: `agent:${task.playbook}`,
        }),
      };
    },
  );
}
