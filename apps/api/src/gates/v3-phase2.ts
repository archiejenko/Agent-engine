import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadDecisionsConfig, loadInfraConfig } from "@ae/config";
import {
  buildDigest,
  type DecisionDeps,
  expireDecisions,
  LEAKS_ARM,
  setSpendTier,
} from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts } from "@ae/verification";
import { createApp } from "../app.ts";

/**
 * v3 Phase 2 gate: one ranked queue fed by many sources; expiry takes the safe default and never
 * counts as Archie's approval; approvals exist only through the decisions path; the daily digest.
 */
export async function runV3Phase2Gate(storage: Storage, root: string) {
  const model = fakeModel();
  const world = await buildSyntheticWorld(storage, model, { count: 600 });
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    synthetic: true,
  });
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    decide: (t, d, e) => service.decide(t, d, e),
  });
  const post = (p: string, b: unknown) =>
    app.request(p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(b),
    });
  const get = async (p: string) =>
    (await app.request(p)).json() as Promise<Record<string, unknown>>;

  // Sources: leads (proposed), email drafts and letters (approved leads), a print batch, a claimed site
  // waiting to publish, an external action with an unknown outcome.
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const leads = await runModule(storage, world.ctx, fw, { asOf: new Date().toISOString() });
  const reachable = new Set(
    (
      await getVerifiedFacts(storage, world.ctx, {
        entities: leads.opportunities.map((x) => x.entity_id),
        fields: ["contact_email"],
        minConfidence: 0,
        asOf: new Date().toISOString(),
        lanes: ["open"],
        caller: "internal",
      })
    ).map((f) => f.entity_id),
  );
  const picked = [
    ...leads.opportunities.filter((x) => reachable.has(x.entity_id)).slice(0, 3),
    ...leads.opportunities.filter((x) => !reachable.has(x.entity_id)).slice(0, 3),
  ];
  for (const o of picked) await storage.opportunities.setStatus(o.opportunity_id, "approved");
  await service.tick(500);
  await post("/api/letters/batches", {});
  const anyEntity = picked[0]?.entity_id as string;
  await storage.siteClaims.create({
    id: "gate-claim",
    slug: "gate-slug",
    entity_id: anyEntity,
    source_task_id: null,
    email: "owner@customer.example",
    name: "Owner",
    status: "checkout_started",
    session_id: "cs_test_gate",
    details_token: "gate-token",
    terms_version: "draft",
    setup_fee_gbp: 149,
    monthly_gbp: 15,
    synthetic: true,
  });
  await storage.siteClaims.update("gate-claim", {
    status: "awaiting_publish",
    workflow_id: "claim-gate-claim",
  });
  await storage.effects.start({
    key: "gate-effect",
    task_id: "gate-task",
    tool: "send_email",
    dry_run: false,
  });

  // 1. One ranked list.
  const q = (await get("/api/decisions")) as {
    open: { id: string; type: string; money_at_stake_gbp: number; source_ref: string }[];
  };
  const types = [...new Set(q.open.map((d) => d.type))];
  const ranked = q.open.every(
    (d, i) =>
      i === 0 ||
      (q.open[i - 1] as { money_at_stake_gbp: number }).money_at_stake_gbp >= d.money_at_stake_gbp,
  );
  const queueJson = JSON.stringify(q);

  // 2. Archie decides one draft through the old button (it routes through the queue).
  const draft = q.open.find((d) => d.type === "draft");
  const draftTask = draft?.source_ref.slice(5) ?? "";
  const viaOld = await post(`/api/tasks/${draftTask}/decision`, { decision: "approve" });
  const decidedDraft = draft ? await storage.decisions.get(draft.id) : null;

  // 3. Everything else expires: safe defaults, recorded as "defaulted", never as an approval.
  const deps: DecisionDeps = {
    storage,
    cfg: loadInfraConfig(),
    dcfg: loadDecisionsConfig(),
    decideTask: (t, d, e) => service.decide(t, d, e),
    now: () => new Date(Date.now() + 400 * 86_400_000),
  };
  const approvalsBefore = (await storage.ownerApprovals.list(1000)).length;
  const defaulted = await expireDecisions(deps);
  const approvalsAfter = (await storage.ownerApprovals.list(1000)).length;
  const closed = await storage.decisions.list({ status: "defaulted", limit: 1000 });
  const defaultedDraft = closed.find((d) => d.type === "draft");
  const draftTaskAfter = defaultedDraft
    ? await storage.tasks.get(defaultedDraft.source_ref.slice(5))
    : null;
  const draftApprovals = defaultedDraft
    ? await storage.approvals.forTask(defaultedDraft.source_ref.slice(5))
    : [];
  const batchD = closed.find((d) => d.type === "print_batch");
  const batch = batchD ? await storage.printBatches.get(batchD.source_ref.slice(6)) : null;
  const effectD = closed.find((d) => d.type === "uncertain_effect");
  const effect = await storage.effects.get("gate-effect");

  // 4. Approvals only through the path: every owner approval belongs to a decision Archie made.
  const approvals = await storage.ownerApprovals.list(1000);
  const decidedByArchie = (await storage.decisions.list({ status: "decided", limit: 1000 })).filter(
    (d) => d.decided_by !== "default" && d.decided_by !== "system",
  );
  const bypass = await setSpendTier(storage, "sme_outreach", "S3", { by: "agent" }).then(
    () => "raised",
    (e: Error) => e.message,
  );

  // 5. Digest.
  const digest = await buildDigest(storage, loadInfraConfig(), {
    day: new Date().toISOString().slice(0, 10),
    includeSynthetic: true,
  });

  const criteria: GateCriterion[] = [
    {
      criterion: "Decisions from many sources appear in one list, ranked by money at stake",
      status: types.length >= 4 && ranked ? "passed (synthetic)" : "failed",
      evidence: `${q.open.length} open decisions from ${types.length} sources (${types.join(", ")}); ordered by money at stake`,
    },
    {
      criterion: "An expired decision takes its safe default and is never counted as an approval",
      status:
        defaulted > 0 &&
        approvalsAfter === approvalsBefore &&
        closed.every(
          (d) =>
            d.decided_by === "default" &&
            d.approval_id === null &&
            d.chosen_option === d.safe_default,
        ) &&
        draftTaskAfter?.status === "cancelled" &&
        draftApprovals.length === 0 &&
        batch?.status === "rejected" &&
        effectD?.chosen_option === "leave" &&
        effect?.status === "started"
          ? "passed (synthetic)"
          : "failed",
      evidence: `${defaulted} decisions defaulted (${[...new Set(closed.map((d) => d.type))].join(", ")}); owner approvals ${approvalsBefore} → ${approvalsAfter}; the defaulted draft was cancelled with no approval-history row; the batch was rejected (nothing printed); the uncertain action stays blocked (never repeated)`,
    },
    {
      criterion: "No approval can be created except through the decisions path",
      status:
        viaOld.status === 200 &&
        decidedDraft?.status === "decided" &&
        decidedDraft.approval_id !== null &&
        approvals.length === decidedByArchie.length &&
        approvals.every((a) => decidedByArchie.some((d) => d.approval_id === a.id)) &&
        /needs Archie's recorded approval/.test(bypass)
          ? "passed (synthetic)"
          : "failed",
      evidence: `old "approve draft" button → decision ${decidedDraft?.status} with approval ${decidedDraft?.approval_id?.slice(0, 8)}; ${approvals.length} owner approval(s) = ${decidedByArchie.length} decision(s) Archie made; raising a tier without a decision: refused; static check: only packages/infra/src/decisions.ts creates owner approvals (tests/architecture.test.ts)`,
    },
    {
      criterion: "The queue keeps the holdout hidden",
      status: !LEAKS_ARM.test(queueJson) ? "passed (synthetic)" : "failed",
      evidence: "no arm or cohort in any decision (summaries and draft context)",
    },
    {
      criterion: "Daily digest: what happened, earned, spent and waiting",
      status:
        digest.happened.sent !== undefined &&
        typeof digest.spent_gbp === "number" &&
        digest.defaulted.length === defaulted
          ? "passed (synthetic)"
          : "failed",
      evidence: `today: ${Object.entries(digest.happened)
        .map(([k, n]) => `${n} ${k}`)
        .join(
          ", ",
        )}; earned £${digest.earned_gbp}, spent £${digest.spent_gbp}; ${digest.decided} decided, ${digest.defaulted.length} defaulted, ${digest.waiting.open} waiting`,
    },
  ];
  return { criteria };
}
