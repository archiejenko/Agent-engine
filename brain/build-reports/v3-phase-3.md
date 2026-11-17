---
type: build-report
phase: v3-3
date: 2026-11-17
status: gate passed (synthetic); Email Routing handler and MCP transport unverified against live use
---

# v3 Phase 3: Inbox and mailbox (gate report)

## What changed

**The Inbox has five tabs:**

| Tab | What it shows |
|---|---|
| Awaiting approval | email and reply drafts; the same items as the one queue, filtered to drafts |
| Sent | outbox emails, including dry runs and blocked ones with their reason |
| Replies | inbound mail, marked untrusted |
| Agent drafts | drafts agents saved in the mailbox |
| Letters | the print queue and claimed sites |

Every message links to its company in the CRM and shows its task. The company page shows its ledger
events. **Thread ids are never shown**, because they would reveal which arm an email came from (rule 22).

**The mailbox** (decision D1) is one dedicated address on the sending domain, never your inbox. Messages are
stored in `mail_messages` (migration 0015). They arrive two ways:

- **Cloudflare Email Routing → the Worker's `email()` handler.** It reads the raw message with a small,
  tested MIME reader (plain text, multipart, quoted-printable, base64, encoded subjects). It then links the
  reply to the email it answers through the `replies+<outbox id>@` subaddress (or the In-Reply-To header),
  and stores it as untrusted. The reply loop on Workers reads from here.
- **Locally**, the fake inbox. Every reply the loop processes is also saved to the mailbox.

**`MailboxPort`** has exactly three operations: list, read and create draft. **There is no send, delete or
forward**, and a test fails if one is ever added.

**Agents get the same three operations** (decision D6):
- **As registry tools:** `mailbox_list`, `mailbox_read`, `mailbox_draft`. None is external. The operator
  role can't read mail, so it never sees raw untrusted content. Reading returns content flagged untrusted.
- **As an MCP endpoint:** `/api/mcp/mailbox` (behind Access). Tools `list`, `read`, `create_draft`; any
  other tool name is an error.

Sending stays the `send_email` tool, behind the one queue.

## Gate (`pnpm gate:v3 --phase 3`, docs/gates/v3-phase3.md)

| Criterion | Status |
|---|---|
| A fixture mailbox shows the three tabs (awaiting approval, sent, replies), linked to company and task; no thread ids or arms exposed | passed (synthetic) |
| An agent can draft but has no way to send (registry and MCP: `send`/`forward` → unknown tool; outbox unchanged; the operator can't read mail) | passed (synthetic) |
| Prompt-injection replies (3 fixtures) trigger no tool call; nothing reaches the attacker's address | passed (synthetic) |

`pnpm check` is green: 382 tests in 50 files. The Worker builds with the `email()` handler.

**A bug the gate caught:** the MIME reader took the empty preamble before the first boundary as the text
part. Fixed, with unit tests.

## Unverified (listed for the Milestone C report)

1. **MCP transport** (`/api/mcp/mailbox`). It's JSON-RPC with `initialize`, `tools/list` and `tools/call`,
   written without access to the MCP specification, which is blocked from this environment. Check the
   method names, the handshake and the transport before any external agent connects. Our own playbooks use
   the registry tools, not MCP.
2. **Email Routing on the real domain.** The handler follows the current Cloudflare docs, but it has never
   received real mail. At cutover:
   - add an Email Routing rule sending `replies@<sending domain>` (with subaddressing on) to the Worker;
   - make the chosen sending provider use `replies+<outbox id>@…` as the Reply-To.
3. **Sending provider:** not chosen (decision D1). When shortlisting, check its terms allow B2B cold outreach.

Next: Phase 4, the Vault.
