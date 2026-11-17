import { loadInfraConfig } from "@ae/config";
import {
  backlinksOf,
  buildDigest,
  CRM_STAGES,
  crmCompany,
  crmCsv,
  crmList,
  type DecisionDeps,
  DecisionError,
  decide,
  type GitNote,
  homeFigures,
  IDEAS_PATH,
  IdeaImportError,
  ideasSheetView,
  importIdeas,
  KeyError,
  KeyRing,
  needsYou,
  searchVault,
  storageMailbox,
  vaultNotes,
  writeArchieNote,
} from "@ae/infra";
import type { KeyStore } from "@ae/ports";

/** The only mailbox tools on the MCP endpoint (no send, delete or forward). */
export const MAILBOX_MCP_TOOLS = [
  {
    name: "list",
    description: "List mailbox messages",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", enum: ["inbox", "drafts"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "read",
    description: "Read one message (untrusted content)",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_draft",
    description: "Save a draft (never sends)",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
];

import type { Storage } from "@ae/storage";
import type { Hono } from "hono";
import { z } from "zod";

/** v3 Milestone C routes (behind Access): Home figures and the CRM. */
const Range = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  playbook: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional(),
  synthetic: z.enum(["0", "1"]).optional(),
});

const CrmQuery = z.object({
  search: z.string().trim().max(100).optional(),
  stage: z.enum(CRM_STAGES).optional(),
  synthetic: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const Decide = z.object({
  option: z.string().min(1).max(40),
  edited_text: z.string().min(1).max(5000).nullable().optional(),
  exclude: z.array(z.string().max(100)).max(1000).optional(),
});

export function mountV3(
  // biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
  app: Hono<any>,
  storageFor: (env: unknown) => Storage,
  decisionDeps: (env: unknown) => DecisionDeps,
  // biome-ignore lint/suspicious/noExplicitAny: Hono context type is generic across runtimes.
  accessUser: (c: any) => string,
  vaultSource: () => Promise<GitNote[]>,
  keyStoreFor: (env: unknown) => KeyStore,
) {
  // ---- Phase 5: Keys (rule 20). Write-only: no route returns a value; responses are never cached.
  const ring = (env: unknown) => new KeyRing(keyStoreFor(env), storageFor(env));
  app.get("/api/keys", async (c) => {
    c.header("cache-control", "no-store");
    return c.json({ keys: await ring(c.env).list() });
  });
  app.put("/api/keys/:name", async (c) => {
    c.header("cache-control", "no-store");
    const b = z.object({ value: z.string() }).safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    try {
      await ring(c.env).set(c.req.param("name"), b.data.value, accessUser(c));
      return c.json({ ok: true, name: c.req.param("name"), status: "set" });
    } catch (e) {
      // KeyRing errors are already scrubbed of the value; anything else gets a generic message.
      const msg = e instanceof KeyError ? e.message : "could_not_save";
      return c.json(
        { error: msg },
        msg === "unknown_key" ? 404 : msg === "invalid_value" ? 400 : 502,
      );
    }
  });

  // ---- Phase 4: the Vault (brain/ + versions). Archie edits are new versions; agents write via
  // writeAgentNote (provenance required), never through this route.
  const notes = async (env: unknown) => vaultNotes(storageFor(env), await vaultSource());
  app.get("/api/vault", async (c) => {
    const all = await notes(c.env);
    const text = c.req.query("search");
    const tag = c.req.query("tag");
    const found = searchVault(all, { ...(text ? { text } : {}), ...(tag ? { tag } : {}) });
    return c.json({
      tags: [...new Set(all.flatMap((n) => n.tags))].sort(),
      notes: found.map((n) => ({
        path: n.path,
        title: n.title,
        tags: n.tags,
        author: n.author,
        version: n.version,
        updated_at: n.updated_at,
        labels: n.provenance.labels,
        edited_here: n.edited_here,
      })),
    });
  });
  app.get("/api/vault/note", async (c) => {
    const path = c.req.query("path") ?? "";
    const all = await notes(c.env);
    const n = all.find((x) => x.path === path);
    if (!n) return c.json({ error: "not_found" }, 404);
    return c.json({
      ...n,
      backlinks: backlinksOf(all, path),
      history: (await storageFor(c.env).noteVersions.history(path)).map((v) => ({
        version: v.version,
        author: v.author,
        created_at: v.created_at,
        provenance: v.provenance,
      })),
    });
  });
  app.put("/api/vault/note", async (c) => {
    const b = z
      .object({ path: z.string().min(7).max(300), body: z.string().max(500_000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request" }, 400);
    try {
      const version = await writeArchieNote(storageFor(c.env), b.data.path, b.data.body);
      return c.json({ ok: true, version });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/vault/ideas", async (c) => {
    const sheet = (await notes(c.env)).find((n) => n.path === IDEAS_PATH);
    if (!sheet) return c.json({ present: false, path: IDEAS_PATH });
    const s = storageFor(c.env);
    return c.json({
      present: true,
      path: IDEAS_PATH,
      ...ideasSheetView(sheet.body),
      backlog: {
        hypotheses: await s.hypotheses.count(),
        last_import: await s.hypotheses.lastImport(),
      },
    });
  });
  // Imports the sheet into the hypothesis backlog (idempotent on id; the whole file is rejected if any
  // row is invalid). Not an approval: it changes no decision Archie has made.
  app.post("/api/vault/ideas/import", async (c) => {
    const sheet = (await notes(c.env)).find((n) => n.path === IDEAS_PATH);
    if (!sheet) return c.json({ error: "no_ideas_file", path: IDEAS_PATH }, 404);
    try {
      return c.json({
        ok: true,
        ...(await importIdeas(storageFor(c.env), sheet.body, { by: accessUser(c) })),
      });
    } catch (e) {
      if (e instanceof IdeaImportError)
        return c.json({ error: "rejected", message: e.message, ...e.report, rows: undefined }, 422);
      throw e;
    }
  });

  // ---- Phase 2: the Needs-you queue (the only approval path) and the daily digest.
  app.get("/api/decisions", async (c) => {
    const type = c.req.query("type");
    const d = decisionDeps(c.env);
    const open = await needsYou(d, { ...(type ? { type } : {}) });
    return c.json({
      open,
      recent: (await d.storage.decisions.list({ limit: 30 }))
        .filter((x) => x.status !== "open")
        .slice(0, 15),
    });
  });

  app.post("/api/decisions/:id/decide", async (c) => {
    const b = Decide.safeParse(await c.req.json().catch(() => null));
    if (!b.success) return c.json({ error: "bad_request", issues: b.error.issues }, 400);
    try {
      const x = await decide(decisionDeps(c.env), c.req.param("id"), b.data.option, accessUser(c), {
        ...(b.data.edited_text ? { edited_text: b.data.edited_text } : {}),
        ...(b.data.exclude ? { exclude: b.data.exclude } : {}),
      });
      return c.json({ ok: !x.error, decision: x }, x.error ? 409 : 200);
    } catch (e) {
      if (e instanceof DecisionError) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  // ---- Phase 3: Inbox (sent, replies, agent drafts) and the mailbox MCP endpoint.
  app.get("/api/inbox", async (c) => {
    const s = storageFor(c.env);
    const tab = c.req.query("tab") ?? "sent";
    const name = async (id: string | null) =>
      id ? ((await s.entities.get(id))?.name ?? id) : null;
    if (tab === "sent") {
      // No thread ids here: they'd show which arm an email came from (rule 22).
      const rows = await s.outbox.list(200);
      return c.json({
        messages: await Promise.all(
          rows.map(async (m) => ({
            id: m.id,
            to: m.recipient,
            subject: m.subject,
            body: m.body,
            status: m.status,
            reason: m.reason,
            at: m.created_at,
            entity_id: m.entity_id,
            company: await name(m.entity_id),
            task_id: m.task_id,
          })),
        ),
      });
    }
    const folder = tab === "drafts" ? "drafts" : "inbox";
    const rows = await s.mail.list({ folder, limit: 200 });
    return c.json({
      messages: await Promise.all(
        rows.map(async (m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          subject: m.subject,
          body: m.body,
          untrusted: m.untrusted,
          at: m.received_at,
          entity_id: m.entity_id,
          company: await name(m.entity_id),
          task_id: m.task_id,
          author: m.author,
          answers: m.in_reply_to,
        })),
      ),
    });
  });

  /**
   * Mailbox as an MCP server for agents (decision D6): tools list, read and create_draft only. There is
   * no send, delete or forward tool. UNVERIFIED: written without access to the MCP specification (its
   * site was blocked from the build environment); check the JSON-RPC method names, the initialize
   * handshake and the transport against the spec before any external agent connects. Behind Access.
   */
  app.post("/api/mcp/mailbox", async (c) => {
    const req = (await c.req.json().catch(() => null)) as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    } | null;
    const id = req?.id ?? null;
    const reply = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) =>
      c.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (req?.jsonrpc !== "2.0" || !req.method) return fail(-32600, "invalid request");
    const mailbox = storageMailbox(storageFor(c.env));
    if (req.method === "initialize")
      return reply({
        serverInfo: { name: "ae-mailbox", version: "0.1.0-unverified" },
        capabilities: { tools: {} },
      });
    if (req.method === "tools/list") return reply({ tools: MAILBOX_MCP_TOOLS });
    if (req.method !== "tools/call") return fail(-32601, `unknown method ${req.method}`);
    const a = req.params?.arguments ?? {};
    const text = (v: unknown) => reply({ content: [{ type: "text", text: JSON.stringify(v) }] });
    switch (req.params?.name) {
      case "list":
        return text(
          await mailbox.list({
            folder: a.folder === "drafts" ? "drafts" : "inbox",
            limit: Number(a.limit ?? 20),
          }),
        );
      case "read":
        // Inbound mail is untrusted: the caller must treat it as data, never as instructions.
        return text({ untrusted: true, message: await mailbox.read(String(a.id ?? "")) });
      case "create_draft":
        return text(
          await mailbox.createDraft({
            to: String(a.to ?? ""),
            subject: String(a.subject ?? ""),
            body: String(a.body ?? ""),
            author: "agent:mcp",
          }),
        );
      default:
        return fail(-32601, `unknown tool ${req.params?.name ?? ""}`);
    }
  });

  app.get("/api/digest", async (c) => {
    const s = storageFor(c.env);
    const day = c.req.query("day");
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const stored = await s.digests.get(day);
      return c.json(stored?.body ?? (await buildDigest(s, loadInfraConfig(), { day })));
    }
    const latest = await s.digests.latest();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    return c.json(latest?.body ?? (await buildDigest(s, loadInfraConfig(), { day: yesterday })));
  });

  app.get("/api/home", async (c) => {
    const q = Range.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_request", issues: q.error.issues }, 400);
    const to = q.data.to ? new Date(`${q.data.to}T00:00:00Z`) : new Date();
    const toEnd = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate() + 1));
    const from = q.data.from
      ? `${q.data.from}T00:00:00.000Z`
      : new Date(toEnd.getTime() - 30 * 86_400_000).toISOString();
    return c.json(
      await homeFigures(storageFor(c.env), loadInfraConfig(), {
        from,
        to: toEnd.toISOString(),
        ...(q.data.playbook ? { playbook: q.data.playbook } : {}),
        includeSynthetic: q.data.synthetic === "1",
      }),
    );
  });

  app.get("/api/crm", async (c) => {
    const q = CrmQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_request", issues: q.error.issues }, 400);
    return c.json(
      await crmList(storageFor(c.env), {
        ...(q.data.search ? { search: q.data.search } : {}),
        ...(q.data.stage ? { stage: q.data.stage } : {}),
        includeSynthetic: q.data.synthetic === "1",
        limit: q.data.limit,
        offset: q.data.offset,
      }),
    );
  });

  app.get("/api/crm.csv", async (c) => {
    const q = CrmQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "bad_request" }, 400);
    const r = await crmList(storageFor(c.env), {
      ...(q.data.search ? { search: q.data.search } : {}),
      ...(q.data.stage ? { stage: q.data.stage } : {}),
      includeSynthetic: q.data.synthetic === "1",
      limit: 100_000,
      offset: 0,
    });
    return c.body(crmCsv(r.rows), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="crm.csv"',
    });
  });

  app.get("/api/crm/:id", async (c) => {
    const id = c.req.param("id").toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(id)) return c.json({ error: "bad_company_number" }, 400);
    return c.json(await crmCompany(storageFor(c.env), id, c.req.query("synthetic") === "1"));
  });
}
