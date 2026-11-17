/**
 * The outreach mailbox port (v3 Phase 3, decision D1/D6). Read and draft only: there is deliberately
 * NO send, delete or forward here. Sending is the `send_email` tool in the registry, behind approval or
 * (later) a standing rule.
 */
export interface MailboxSummary {
  id: string;
  folder: "inbox" | "drafts";
  from: string;
  to: string;
  subject: string;
  received_at: string;
  entity_id: string | null;
  task_id: string | null;
  in_reply_to: string | null;
}
export interface MailboxMessage extends MailboxSummary {
  body: string;
  /** Inbound mail is untrusted: pass it to a model only as untrusted input. */
  untrusted: boolean;
}
export interface DraftInput {
  to: string;
  subject: string;
  body: string;
  in_reply_to?: string | null;
  entity_id?: string | null;
  task_id?: string | null;
  author: string;
}
export interface MailboxPort {
  list(o: { folder: "inbox" | "drafts"; limit: number; since?: string }): Promise<MailboxSummary[]>;
  read(id: string): Promise<MailboxMessage | null>;
  createDraft(d: DraftInput): Promise<{ id: string }>;
}

/** The only mailbox operations that exist. A test checks nothing else is ever exposed. */
export const MAILBOX_OPERATIONS = ["list", "read", "createDraft"] as const;

/**
 * Minimal RFC 5322 / MIME text reader for inbound mail: headers, and the first text/plain part
 * (quoted-printable and base64 decoded). Enough for replies; swap for a full parser if mail gets complex.
 */
export function parseRawEmail(raw: string): { headers: Record<string, string>; text: string } {
  const split = (s: string) => {
    const i = s.search(/\r?\n\r?\n/);
    return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i).replace(/^\r?\n\r?\n/, "")];
  };
  const headersOf = (block: string) => {
    const h: Record<string, string> = {};
    for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
      const k = line.indexOf(":");
      if (k > 0) h[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
    }
    return h;
  };
  const decode = (body: string, enc: string | undefined) => {
    const e = (enc ?? "").toLowerCase();
    if (e === "base64") {
      try {
        return new TextDecoder().decode(
          Uint8Array.from(atob(body.replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
        );
      } catch {
        return body;
      }
    }
    if (e === "quoted-printable")
      return body
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, x: string) => String.fromCharCode(Number.parseInt(x, 16)));
    return body;
  };
  // RFC 2047 encoded words in headers ("=?utf-8?q?Re=3A_hello?=", "=?utf-8?b?...?=").
  const words = (v: string) =>
    v.replace(/=\?([^?]+)\?([qQbB])\?([^?]*)\?=/g, (_, _cs: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toLowerCase() === "b"
            ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
            : Uint8Array.from(
                text
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-F]{2})/gi, (_m, x: string) =>
                    String.fromCharCode(Number.parseInt(x, 16)),
                  ),
                (c) => c.charCodeAt(0),
              );
        return new TextDecoder().decode(bytes);
      } catch {
        return text;
      }
    });
  const [head, body] = split(raw) as [string, string];
  const headers = Object.fromEntries(
    Object.entries(headersOf(head)).map(([k, v]) => [k, words(v)]),
  );
  const ctype = headers["content-type"] ?? "text/plain";
  const boundary = ctype.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary)
    return { headers, text: decode(body, headers["content-transfer-encoding"]).trim() };
  // Index 0 is the preamble before the first boundary; a part starting "--" is the closing marker.
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const [ph, pb] = split(part.replace(/^\r?\n/, "")) as [string, string];
    const h = headersOf(ph);
    if ((h["content-type"] ?? "text/plain").toLowerCase().startsWith("text/plain"))
      return {
        headers,
        text: decode(pb, h["content-transfer-encoding"])
          .replace(/\r?\n--\s*$/, "")
          .trim(),
      };
  }
  return { headers, text: "" };
}

/** "replies+<outbox id>@mail.example" → "<outbox id>" (Email Routing supports subaddressing). */
export function replyTokenOf(to: string): string | null {
  return to.match(/^[^+@\s]+\+([A-Za-z0-9-]{8,64})@/)?.[1] ?? null;
}
