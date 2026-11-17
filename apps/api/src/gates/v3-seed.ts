import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCriterion } from "@ae/agent-runner";
import { loadIdeaCategoriesConfig, loadInfraConfig } from "@ae/config";
import {
  applyIdeaDecision,
  changeIdeaScore,
  estimatePaid,
  homeFigures,
  IDEAS_PATH,
  setIdeaStage,
  validateIdeasSheet,
} from "@ae/infra";
import type { Storage } from "@ae/storage";
import { createApp } from "../app.ts";

/**
 * Seeded ideas gate (v3 Phase 4 part of the seed-500 brief): import as hypotheses, idempotent re-import
 * that keeps Archie's decisions, whole-file rejection with row numbers, recomputed scores, estimates kept
 * out of every learning and scoring path, the taxonomy map, and the Vault view.
 */
export async function runV3SeedGate(storage: Storage, root: string) {
  const full = readFileSync(join(root, IDEAS_PATH), "utf8");
  const fixture = readFileSync(
    join(root, "packages/infra/src/__tests__/fixtures/seed-ideas-10.csv"),
    "utf8",
  );
  let sheet = fixture;
  const app = createApp({
    runtime: "node",
    storage: () => storage,
    vault: async () => [{ path: IDEAS_PATH, body: sheet }],
  });
  const importNow = async () => {
    const r = await app.request("/api/vault/ideas/import", { method: "POST" });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const lines = (t: string) => t.split(/\r?\n/).filter(Boolean);
  const header = (lines(fixture)[0] as string).split(",");
  const edit = (t: string, id: string, col: string, v: string) =>
    `${lines(t)
      .map((l) => {
        if (!l.startsWith(`${id},`)) return l;
        const cells = l.split(",");
        cells[header.indexOf(col)] = v;
        return cells.join(",");
      })
      .join("\r\n")}\r\n`;

  // Learning and scoring figures BEFORE any idea exists.
  const cfg = loadInfraConfig();
  const window = {
    from: "2000-01-01T00:00:00.000Z",
    to: "2100-01-01T00:00:00.000Z",
    includeSynthetic: true,
  };
  const asOf = new Date().toISOString();
  const snapshot = async () =>
    JSON.stringify({
      paid: await estimatePaid(storage, cfg, "sme_outreach", asOf),
      home: await homeFigures(storage, cfg, window),
      ledger: await storage.ledgerRange(window),
    });
  const before = await snapshot();

  // 1. Fixture imports cleanly.
  const first = await importNow();
  const hyps = await storage.hypotheses.list();
  const history0 = (await Promise.all(hyps.map((h) => storage.hypotheses.history(h.id)))).flat();
  const built = hyps.filter((h) => h.file_status === "Built");

  // 2. Archie fails one; an agent moves another's stage; the sheet changes; re-import.
  const [failed, staged, edited] = hyps as [(typeof hyps)[0], (typeof hyps)[0], (typeof hyps)[0]];
  await applyIdeaDecision(storage, failed.id, "Fail", "archie", "Tried it before");
  await setIdeaStage(storage, staged.id, "testing", "agent:researcher");
  sheet = edit(
    edit(edit(fixture, failed.id, "decision", "Pass"), staged.id, "status", "Built"),
    edited.id,
    "margin",
    "1",
  );
  const second = await importNow();
  const failedAfter = await storage.hypotheses.get(failed.id);
  const stagedAfter = await storage.hypotheses.get(staged.id);
  const editedAfter = await storage.hypotheses.get(edited.id);
  const editedHistory = await storage.hypotheses.history(edited.id);

  // 3. A score of 6 rejects the whole file and names the row; nothing changes.
  const countBefore = await storage.hypotheses.count();
  const marginBefore = (await storage.hypotheses.get(edited.id))?.margin;
  sheet = edit(edit(fixture, staged.id, "autonomy", "6"), edited.id, "margin", "5");
  const rejected = await importNow();
  const rejectedRows = (rejected.body.rejected ?? []) as {
    row: number;
    id: string;
    problems: string[];
  }[];
  const unchanged =
    (await storage.hypotheses.count()) === countBefore &&
    (await storage.hypotheses.get(edited.id))?.margin === marginBefore;

  // 4. All 500 rows: recomputed score and matrix match the file.
  const all = validateIdeasSheet(full);

  // 5. Import all 500, change a score; learning and scoring figures don't move.
  sheet = full;
  const fullImport = await importNow();
  await changeIdeaScore(storage, "I001", "demand", 1, {
    by: "agent:researcher",
    reason: "gate check",
  });
  const after = await snapshot();
  const ledgerHits = await storage.audit.tablesContaining("seeded estimate");

  // 6. Taxonomy map.
  const cats = loadIdeaCategoriesConfig().categories;
  const used = [...new Set(all.rows.map((r) => r.category))];
  const unmapped = used.filter((c) => !cats[c]?.node);
  const mapped = used.filter((c) => cats[c]?.node);

  // 7. The Vault view.
  const view = (await (await app.request("/api/vault/ideas")).json()) as {
    rows: { id: string; card: string; score_source: string }[];
    backlog: { hypotheses: number };
  };

  const criteria: GateCriterion[] = [
    {
      criterion: "A 10-row fixture imports cleanly as hypotheses, every score labelled estimate",
      status:
        first.status === 200 &&
        first.body.created === 10 &&
        hyps.length === 10 &&
        hyps.every((h) => h.score_source === "estimate") &&
        built.length === 1 &&
        built.every((h) => h.stage === "live") &&
        hyps.filter((h) => h.file_status === "New").every((h) => h.stage === "proposed") &&
        history0.length === 60
          ? "passed (synthetic)"
          : "failed",
      evidence: `10 created; stage "proposed" for New and "live" for the Built row (${built[0]?.id}); 60 starting score-history rows (six per idea, by "import")`,
    },
    {
      criterion:
        "A re-import after Archie marks one idea Fail keeps the decision (and comments, and a stage someone changed)",
      status:
        second.status === 200 &&
        failedAfter?.decision === "Fail" &&
        failedAfter.decision_by === "archie" &&
        failedAfter.comments === "Tried it before" &&
        stagedAfter?.stage === "testing" &&
        editedAfter?.margin === 1 &&
        editedHistory.at(-1)?.changed_by === "import"
          ? "passed (synthetic)"
          : "failed",
      evidence: `the sheet said ${failed.id} = Pass: it stays Fail (by archie, comment kept); the sheet marked ${staged.id} Built: its stage stays "testing" (set by an agent); ${edited.id}'s margin follows the sheet (5 → 1) with a history row`,
    },
    {
      criterion:
        "A row with a score of 6 is rejected; the whole file is refused and the row is named",
      status:
        rejected.status === 422 &&
        rejectedRows.length === 1 &&
        rejectedRows[0]?.id === staged.id &&
        /autonomy "6" is outside 1–5/.test(rejectedRows[0]?.problems.join() ?? "") &&
        unchanged
          ? "passed (synthetic)"
          : "failed",
      evidence: `HTTP ${rejected.status}: row ${rejectedRows[0]?.row} (${rejectedRows[0]?.id}): ${rejectedRows[0]?.problems.join(", ")}; nothing written (a valid change in another row was not applied either)`,
    },
    {
      criterion: "Recomputed score and matrix match the file for all 500 rows",
      status:
        all.ok && all.rows.length === 500 && all.mismatches.length === 0
          ? "passed (synthetic)"
          : "failed",
      evidence: `${all.rows.length} rows validated; ${all.mismatches.length} disagreements (score = weighted mean of the six scores as a share of 5; matrix from value and feasibility, 4+ = high)`,
    },
    {
      criterion: "No seeded score appears in any learning or scoring query",
      status:
        fullImport.status === 200 &&
        before === after &&
        ledgerHits.every((t) => t.startsWith("hypothes"))
          ? "passed (synthetic)"
          : "failed",
      evidence: `500 imported and a score changed: P(paid), every Home figure and the outcome ledger are byte-for-byte unchanged; seeded rows exist only in the hypotheses tables (${ledgerHits.join(", ")}); static tests keep scoring, learning, ledger and verification code and all other SQL away from them (tests/architecture.test.ts)`,
    },
    {
      criterion:
        "Each of the 25 categories maps to the nearest taxonomy node, or is listed for Archie",
      status: used.length === 25 && used.every((c) => cats[c]) ? "passed (synthetic)" : "failed",
      evidence: `${mapped.length} mapped (${mapped.map((c) => `${c} → ${cats[c]?.node}`).join("; ")}). NOT mapped, for you to place: ${unmapped.map((c) => `${c} (${cats[c]?.why})`).join("; ")}`,
    },
    {
      criterion: "The Vault shows the file as a browsable note with a link to each idea's card",
      status:
        view.rows.length === 500 &&
        view.rows.every((r) => r.card === `#/ideas/${r.id}` && r.score_source === "estimate") &&
        view.backlog.hypotheses === 500
          ? "passed (synthetic)"
          : "failed",
      evidence: `500 rows, each labelled estimate and linked to #/ideas/<id> (the card itself is Phase 6); backlog shows ${view.backlog.hypotheses} hypotheses`,
    },
  ];
  return { criteria, unmapped };
}
