import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentService,
  buildSyntheticWorld,
  fakeModel,
  type GateCriterion,
  loadPlaybooks,
} from "@ae/agent-runner";
import { loadInfraConfig } from "@ae/config";
import {
  assessCandidates,
  DEMO_PRIVACY_LINE,
  demoBeaconHash,
  drawHoldout,
  estimatePaid,
  holdoutSize,
  K,
  letterSuppressionKey,
  setKillSwitch,
} from "@ae/infra";
import { parseFramework, runModule } from "@ae/opportunity";
import { FakeInbox } from "@ae/ports";
import type { Storage } from "@ae/storage";
import { getVerifiedFacts } from "@ae/verification";
import { createApp } from "../app.ts";

/**
 * v2 Phase 1 gate, run by the SIMULATOR: a synthetic world, one outreach cohort end to end through the
 * real API and agent service, with simulated replies, demo visits and a payment. Every row it writes is
 * synthetic = 1, and the gate checks that none of it reaches learning.
 */
export async function runV2Phase1Gate(
  storage: Storage,
  root: string,
  o: { count: number; leads: number; letters: number; log?: (m: string) => void },
) {
  const log = o.log ?? (() => {});
  const model = fakeModel();
  const world = await buildSyntheticWorld(storage, model, { count: o.count, log });
  const infra = loadInfraConfig();
  const inbox = new FakeInbox();
  const service = new AgentService({
    storage,
    playbooks: await loadPlaybooks(join(root, "playbooks")),
    model,
    inbox,
    synthetic: true,
  });
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    decide: (t, d, e) => service.decide(t, d, e),
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const universeName = world.universe.name;

  // 1. Leads, and a block of companies that must never be contacted (asked for no more letters).
  const fw = await parseFramework(
    readFileSync(join(root, "brain/frameworks/lead_gen_sme_web.md"), "utf8"),
  );
  const leads = await runModule(storage, world.ctx, fw, { asOf: new Date().toISOString() });
  const contacts = await getVerifiedFacts(storage, world.ctx, {
    entities: leads.opportunities.map((x) => x.entity_id),
    fields: ["contact_email"],
    minConfidence: 0,
    asOf: new Date().toISOString(),
    lanes: ["open"],
    caller: "internal",
  });
  const reachable = new Set(contacts.map((f) => f.entity_id));
  const picked = [
    ...leads.opportunities.filter((x) => reachable.has(x.entity_id)).slice(0, o.leads),
    ...leads.opportunities.filter((x) => !reachable.has(x.entity_id)).slice(0, o.letters),
  ];
  const pickedIds = new Set(picked.map((p) => p.entity_id));
  const members = (await storage.universe.list(universeName, { included: true })).map(
    (m) => m.entity_id,
  );
  const blocked = members.filter((id) => !pickedIds.has(id)).filter((_, i) => i % 3 === 0);
  for (const id of blocked)
    await storage.suppressions.add(
      letterSuppressionKey(id),
      "simulator: asked for no more letters",
    );

  // 2. The holdout draw is reproducible: same seed → same companies; another seed → others.
  const drawA = await drawHoldout(storage, world.ctx, infra, {
    seed: "seed-1",
    k: 5,
    universeName,
    exclude: pickedIds,
  });
  const drawB = await drawHoldout(storage, world.ctx, infra, {
    seed: "seed-1",
    k: 5,
    universeName,
    exclude: pickedIds,
  });
  const drawC = await drawHoldout(storage, world.ctx, infra, {
    seed: "seed-2",
    k: 5,
    universeName,
    exclude: pickedIds,
  });
  const ids = (d: { entity_id: string }[]) => d.map((x) => x.entity_id).join(",");
  const reproducible = drawA.length === 5 && ids(drawA) === ids(drawB) && ids(drawA) !== ids(drawC);

  // 3. Archie approves the leads → one cohort: ranked tasks + a random holdout.
  for (const p of picked) await storage.opportunities.setStatus(p.opportunity_id, "approved");
  await service.tick(500);
  const cohorts = await storage.cohorts.list({ includeSynthetic: true, limit: 10 });
  const cohort = cohorts[0];
  const cm = cohort ? await storage.cohorts.members(cohort.id) : [];
  const ranked = cm.filter((m) => m.arm === "ranked" && m.status === "assigned");
  const skipped = cm.filter((m) => m.status === "skipped");
  const holdout = cm.filter((m) => m.arm === "holdout");
  const blockedSet = new Set(blocked);
  const holdoutClean =
    holdout.length > 0 &&
    holdout.every((m) => !blockedSet.has(m.entity_id) && !pickedIds.has(m.entity_id));
  const tasks = await storage.tasks.list({ limit: 1000 });
  const allSynthetic = tasks.length > 0 && tasks.every((t) => t.synthetic);

  // 4. Blind review: holdout and ranked drafts look the same in Review.
  const review = (await (await app.request("/api/review")).json()) as {
    drafts: Record<string, unknown>[];
  };
  const arms = new Map(cm.map((m) => [m.task_id, m.arm]));
  const keysOf = (arm: string) =>
    [
      ...new Set(
        review.drafts
          .filter((d) => arms.get(d.task_id as string) === arm)
          .map((d) => Object.keys(d).sort().join(",")),
      ),
    ].join("|");
  const draftJson = JSON.stringify(review.drafts);
  const holdoutDraft = review.drafts.find((d) => arms.get(d.task_id as string) === "holdout");
  const detail = holdoutDraft
    ? JSON.stringify(await (await app.request(`/api/tasks/${holdoutDraft.task_id}`)).json())
    : "";
  const blind =
    review.drafts.length > 0 &&
    !/holdout|cohort|source_ref/.test(draftJson) &&
    (holdoutDraft ? keysOf("holdout") === keysOf("ranked") : true) &&
    !/holdout|"cohort"/.test(detail);

  // 5. Archie approves every email draft (timed) → sent (dry run while the kill switch is on).
  for (const d of review.drafts) {
    await post("/api/review-sessions", {
      item_type: "draft",
      item_id: d.task_id,
      task_ids: [d.task_id],
      started_at: new Date(Date.now() - 45_000).toISOString(),
      decided_at: new Date().toISOString(),
      active_ms: 45_000,
    });
    await post(`/api/tasks/${d.task_id}/decision`, { decision: "approve" });
  }
  await service.tick(500);

  // 6. Letters: assemble and approve the print batch (timed) → sent.
  await post("/api/letters/batches", {});
  const batch = (await storage.printBatches.list(5))[0];
  const batchLetters = batch ? await storage.letters.list({ batchId: batch.id }) : [];
  if (batch) {
    await post("/api/review-sessions", {
      item_type: "print_batch",
      item_id: batch.id,
      task_ids: batchLetters.map((l) => l.task_id),
      started_at: new Date(Date.now() - 120_000).toISOString(),
      decided_at: new Date().toISOString(),
      active_ms: 120_000,
    });
    await post(`/api/letters/batches/${batch.id}/decision`, { decision: "approve" });
  }

  // 7. Demo visits (only while external actions are allowed): a QR scan with time on page, a typed link.
  await setKillSwitch(storage, { playbook: "sme_letter" }, false, "simulator");
  await storage.controls.set(K.global, false, "simulator");
  const [l1, l2] = batchLetters;
  const qr = l1 ? await app.request(`/demo/${l1.demo_slug}?s=qr`) : null;
  const qrHtml = qr ? await qr.text() : "";
  const csp = qr?.headers.get("content-security-policy") ?? "";
  if (l1) await app.request(`/demo/${l1.demo_slug}/t`, { method: "POST", body: "42000" });
  if (l2) await app.request(`/demo/${l2.demo_slug}`);
  await storage.controls.set(K.global, true, "simulator"); // back to the default: external actions off

  // 8. A reply to an email, and a payment entered by hand for that company.
  const sent = (await storage.outbox.list(1000)).filter((m) => m.status === "dry_run");
  const first = sent[0];
  if (first)
    inbox.messages.push({
      id: "sim-reply-1",
      from: first.recipient,
      to: infra.sender.from_email,
      subject: "Re",
      body: "Yes please, send me the demo.",
      received_at: new Date().toISOString(),
      in_reply_to: first.id,
    });
  await service.tick(500);
  const paidRes = first?.entity_id
    ? ((await (
        await post("/api/ledger", { event: "paid", entity_id: first.entity_id, value_gbp: 1500 })
      ).json()) as { ok: boolean; attributed_to: string | null })
    : null;

  // Ledger checks.
  const ledger = await storage.outcomeLedger.list({ limit: 10_000 });
  const by = (e: string) => ledger.filter((r) => r.event === e);
  const emailSent = by("sent").filter((r) => r.source === "outbox");
  const letterSent = by("sent").filter((r) => r.source === "letters");
  const qrRow = by("qr_scan")[0];
  const reply = by("reply")[0];
  const paid = by("paid")[0];
  const estimates = ledger.filter((r) => r.value_kind === "estimate");

  // 9. Learning sees none of it; reports show it only when asked, labelled SIMULATED.
  const est = await estimatePaid(storage, infra, "sme_outreach");
  const liftReal = (await (await app.request("/api/lift")).json()) as {
    cohorts: number;
  };
  const liftSim = (await (await app.request("/api/lift?synthetic=1")).json()) as {
    label: string;
    arms: Record<string, { assigned: number }>;
    events: { event: string; ranked: { companies: number }; holdout: { companies: number } }[];
    supported_by_paid: boolean;
  };
  const econSim = (await (await app.request("/api/economics?synthetic=1")).json()) as {
    label: string;
    by_playbook: {
      key: string;
      send_cost_gbp: number;
      human_minutes: number;
      revenue_gbp: number;
    }[];
  };
  const econReal = (await (await app.request("/api/economics")).json()) as {
    by_playbook: unknown[];
  };
  const letterRow = econSim.by_playbook.find((r) => r.key === "sme_letter");
  const emailRow = econSim.by_playbook.find((r) => r.key === "sme_outreach");

  // Compliance on the holdout: re-check every holdout company was eligible BEFORE the draw (it can't be
  // suppressed or cooled down for reasons that existed then). Suppressed companies are never drawn.
  const suppressedNow = await assessCandidates(storage, world.ctx, infra, blocked.slice(0, 50));
  const suppressedIneligible = [...suppressedNow.values()].every((c) => !c.eligible);

  const criteria: GateCriterion[] = [
    {
      criterion:
        "Every outreach intake is a cohort: ranked leads + a random holdout at the configured share",
      status:
        cohort &&
        ranked.length > 0 &&
        holdout.length === holdoutSize(cohort.ranked, infra.measurement.holdout_share) &&
        cohort.holdout === holdout.length &&
        cohort.seed
          ? "passed (synthetic)"
          : "failed",
      evidence: `cohort ${cohort?.id.slice(0, 8)}: ${ranked.length} ranked (${skipped.length} leads skipped: ${[...new Set(skipped.map((s) => s.reason))].join("; ") || "none"}), ${holdout.length} holdout = round(${cohort?.ranked} × ${infra.measurement.holdout_share} / ${1 - infra.measurement.holdout_share}); seed recorded`,
    },
    {
      criterion: "The holdout draw is random but reproducible from its recorded seed",
      status: reproducible ? "passed (synthetic)" : "failed",
      evidence: `seed-1 twice → the same 5 companies (${ids(drawA)}); seed-2 → a different 5`,
    },
    {
      criterion:
        "Holdout sends pass the same compliance checks (suppression, cooldown, PECR routing, deliverable office)",
      status: holdoutClean && suppressedIneligible ? "passed (synthetic)" : "failed",
      evidence: `${blocked.length} companies on the suppression list; none of them in the holdout; holdout drawn only from eligible companies (${holdout.map((h) => h.channel).join(", ")})`,
    },
    {
      criterion: "Blind review: holdout drafts are indistinguishable from ranked ones",
      status: blind ? "passed (synthetic)" : "failed",
      evidence: `${review.drafts.length} drafts in Review, same fields for both arms, no source reference, cohort or arm in the list or in the task detail while awaiting approval`,
    },
    {
      criterion:
        "Outcome ledger: sent, QR scan, demo visit (with time on page), reply and paid, each attributed to its task, arm and playbook version",
      status:
        emailSent.length === sent.length &&
        emailSent.length > 0 &&
        emailSent.every((r) => r.dry_run && r.task_id && r.cohort_id && r.arm) &&
        letterSent.length === batchLetters.length &&
        qr?.status === 200 &&
        qrRow?.ms_on_page === 42000 &&
        by("demo_visit").length === (l2 ? 2 : 1) &&
        reply?.task_id === first?.task_id &&
        by("reply_positive").length === 1 &&
        paid?.value_gbp === 1500 &&
        paid.value_kind === "actual" &&
        paid.task_id === paidRes?.attributed_to &&
        estimates.every((r) => r.assumption)
          ? "passed (synthetic)"
          : "failed",
      evidence: `${emailSent.length} email sends + ${letterSent.length} letters (all dry run); QR scan ${qr?.status} with ${qrRow?.ms_on_page} ms on page; ${by("demo_visit").length} demo visits; reply → task ${reply?.task_id?.slice(0, 8)} (${reply?.arm}); paid £${paid?.value_gbp} → task ${paid?.task_id?.slice(0, 8)}; ${estimates.length} pre-payment events carry an estimated £ value with its assumption`,
    },
    {
      criterion:
        "Demo pages: no cookies, IP or device details; one hashed script; privacy line shown",
      status:
        qrHtml.includes(DEMO_PRIVACY_LINE) &&
        csp.includes(await demoBeaconHash()) &&
        csp.includes("connect-src 'self'") &&
        !qr?.headers.get("set-cookie")
          ? "passed (synthetic)"
          : "failed",
      evidence: `CSP: ${csp}`,
    },
    {
      criterion: "Synthetic data never trains anything; reports show it only when asked, labelled",
      status:
        allSynthetic &&
        ledger.every((r) => r.synthetic) &&
        est.basis === "prior" &&
        est.evidence.sent === 0 &&
        liftReal.cohorts === 0 &&
        liftSim.label.startsWith("SIMULATED") &&
        (liftSim.arms.ranked?.assigned ?? 0) > 0 &&
        econReal.by_playbook.length === 0 &&
        econSim.label.startsWith("SIMULATED")
          ? "passed (synthetic)"
          : "failed",
      evidence: `${tasks.length} tasks and ${ledger.length} ledger rows, all synthetic; P(paid) still on priors (${est.p_paid.toFixed(4)}, evidence ${JSON.stringify(est.evidence)}); real lift report: ${liftReal.cohorts} cohorts; simulated lift report labelled "${liftSim.label}"`,
    },
    {
      criterion:
        "Lift is measured on assignment (intent to treat), with a 95% interval; no claim without paid outcomes",
      status:
        liftSim.events.some((e) => e.event === "paid") && !liftSim.supported_by_paid
          ? "passed (synthetic)"
          : "failed",
      evidence: liftSim.events
        .map(
          (e) =>
            `${e.event} ${e.ranked.companies}/${liftSim.arms.ranked?.assigned} vs ${e.holdout.companies}/${liftSim.arms.holdout?.assigned}`,
        )
        .join("; "),
    },
    {
      criterion:
        "Unit economics per playbook: model cost, send cost, revenue, margin and Archie's minutes",
      status:
        letterRow &&
        letterRow.send_cost_gbp > 0 &&
        letterRow.human_minutes > 0 &&
        emailRow &&
        emailRow.human_minutes > 0
          ? "passed (synthetic)"
          : "failed",
      evidence: econSim.by_playbook
        .map(
          (r) =>
            `${r.key}: send £${r.send_cost_gbp.toFixed(2)}, revenue £${r.revenue_gbp.toFixed(2)}, ${r.human_minutes} min`,
        )
        .join("; "),
    },
  ];
  return { criteria };
}
