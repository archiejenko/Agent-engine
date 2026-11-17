import { loadInfraConfig } from "@ae/config";
import { CRM_STAGES, crmCompany, crmCsv, crmList, homeFigures } from "@ae/infra";
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

// biome-ignore lint/suspicious/noExplicitAny: the app's env type is generic across runtimes.
export function mountV3(app: Hono<any>, storageFor: (env: unknown) => Storage) {
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
