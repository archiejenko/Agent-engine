import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCriterion } from "@ae/agent-runner";
import { LEAKS_ARM } from "@ae/infra";
import type { Storage } from "@ae/storage";
import { createApp } from "../app.ts";
import { runV2Phase4Gate } from "./v2-phase4.ts";

/**
 * v3 Phase 1 gate: the seven-page shell, Home reconciled to the ledger, a full CRM history, and no
 * company/task view that reveals the holdout. The fixture is the v2 Phase 4 simulator world (letters,
 * emails, a claimed site paid, renewed and refunded, a cancelled claim, holdout members).
 */
export async function runV3Phase1Gate(storage: Storage, root: string) {
  await runV2Phase4Gate(storage, root, { count: 600 });
  const app = createApp({ runtime: "node", storage: () => storage });
  const get = async (p: string) =>
    (await app.request(p)).json() as Promise<Record<string, unknown>>;

  // 1. Seven routes in the navigation (rendering at 390/1440 px is tests/mobile-layout.test.ts).
  const appTsx = readFileSync(join(root, "apps/dashboard/src/App.tsx"), "utf8");
  const nav = [...appTsx.matchAll(/\["(\/[a-z]*)", "([A-Za-z ]+)"\]/g)].map((m) => m[2]);
  const wanted = ["Home", "Ideas", "Board", "Vault", "CRM", "Inbox", "Controls"];

  // 2. Home reconciles to the raw ledger.
  const from = "2000-01-01";
  const home = (await get(`/api/home?from=${from}&synthetic=1`)) as {
    figures: { key: string; value: number | null; kind: string }[];
  };
  const fig = (k: string) => home.figures.find((f) => f.key === k);
  const raw = await storage.ledgerRange({
    from: `${from}T00:00:00.000Z`,
    to: new Date(Date.now() + 86_400_000).toISOString(),
    includeSynthetic: true,
  });
  const sum = (e: string) =>
    raw
      .filter((r) => r.event === e && r.value_kind === "actual")
      .reduce((a, r) => a + (r.value_gbp ?? 0), 0);
  const expRevenue = Math.round((sum("paid") - sum("refunded")) * 100) / 100;
  const expSends = raw.filter((r) => r.event === "sent").length;
  const expSales = new Set(raw.filter((r) => r.event === "paid").map((r) => r.entity_id)).size;
  const realOnly = (await get(`/api/home?from=${from}`)) as {
    figures: { key: string; value: number | null }[];
  };
  const everyLabelled = home.figures.every((f) =>
    ["real", "estimated", "assumed", "dry_run", "synthetic"].includes(f.kind),
  );

  // 3. CRM: a company with the whole story (letter → claim → paid → renewal → refund).
  const claimed = (await storage.siteClaims.list({ includeSynthetic: true, limit: 100 })).find(
    (c) => c.status === "published" || c.status === "refunded",
  );
  const id = claimed?.entity_id ?? "";
  const company = (await get(`/api/crm/${id}?synthetic=1`)) as {
    row: { stage: string } | null;
    contacts: unknown[];
    ledger: { event: string }[];
    claims: unknown[];
    tasks: unknown[];
  };
  const events = new Set(company.ledger.map((e) => e.event));
  const list = (await get("/api/crm?synthetic=1&limit=500")) as {
    total: number;
    counts: Record<string, number>;
  };
  const csv = await (await app.request("/api/crm.csv?synthetic=1")).text();

  // 4. No company, task or message view reveals the holdout.
  const holdout = (
    await Promise.all(
      (
        await storage.cohorts.list({ includeSynthetic: true, limit: 100 })
      ).map((c) => storage.cohorts.members(c.id)),
    )
  )
    .flat()
    .filter((m) => m.arm === "holdout");
  const views: string[] = [JSON.stringify(list), csv, JSON.stringify(await get("/api/review"))];
  for (const m of holdout.slice(0, 5)) {
    views.push(JSON.stringify(await get(`/api/crm/${m.entity_id}?synthetic=1`)));
    if (m.task_id) {
      const t = await storage.tasks.get(m.task_id);
      if (t?.status === "awaiting_approval")
        views.push(JSON.stringify(await get(`/api/tasks/${m.task_id}`)));
    }
  }
  const leaks = views.filter((v) => LEAKS_ARM.test(v)).length;

  const criteria: GateCriterion[] = [
    {
      criterion:
        "All seven routes are in the navigation and render (phone and desktop: tests/mobile-layout.test.ts)",
      status:
        wanted.every((w) => nav.includes(w)) && nav.length === 7 ? "passed (synthetic)" : "failed",
      evidence: `navigation: ${nav.join(", ")}; old links (#/review, #/letters, #/facts, #/metrics, #/golden, #/company/…) redirect to their new place`,
    },
    {
      criterion:
        "Home figures reconcile to the ledger, and every tile says what kind of number it is",
      status:
        fig("revenue")?.value === expRevenue &&
        fig("sends")?.value === expSends &&
        fig("sales")?.value === expSales &&
        everyLabelled &&
        fig("revenue")?.kind === "synthetic" &&
        realOnly.figures.find((f) => f.key === "sends")?.value === 0
          ? "passed (synthetic)"
          : "failed",
      evidence: `revenue £${fig("revenue")?.value} = paid − refunded in the ledger (£${expRevenue}); sends ${fig("sends")?.value} = ${expSends} sent rows; sales ${fig("sales")?.value} = ${expSales} paying companies; with simulated rows off, sends = ${realOnly.figures.find((f) => f.key === "sends")?.value}; labels: ${[...new Set(home.figures.map((f) => f.kind))].join(", ")}`,
    },
    {
      criterion: "The CRM shows a full history for a fixture company",
      status:
        company.row !== null &&
        company.contacts.length > 0 &&
        ["sent", "checkout_started", "paid", "refunded"].every((e) => events.has(e)) &&
        company.claims.length > 0 &&
        company.tasks.length > 0 &&
        list.total > 0 &&
        csv.split("\n").length === list.total + 1
          ? "passed (synthetic)"
          : "failed",
      evidence: `${id}: stage ${company.row?.stage}; ${company.contacts.length} contact(s), ledger ${[...events].join(", ")}, ${company.claims.length} claim, ${company.tasks.length} task(s); list ${list.total} companies (${Object.entries(
        list.counts,
      )
        .filter(([, n]) => n)
        .map(([s, n]) => `${s} ${n}`)
        .join(", ")}); CSV export matches`,
    },
    {
      criterion: "No company, task or message view reveals the holdout arm",
      status: holdout.length > 0 && leaks === 0 ? "passed (synthetic)" : "failed",
      evidence: `${views.length} views checked (CRM list, CSV, Review, ${Math.min(5, holdout.length)} holdout companies and their waiting drafts): ${leaks} mention an arm or cohort`,
    },
  ];
  return { criteria };
}
