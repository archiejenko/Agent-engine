import {
  type IdeaCategoriesConfig,
  type IdeaFunctionsConfig,
  INDUSTRY_CATEGORIES,
  loadIdeaCategoriesConfig,
  loadIdeaFunctionsConfig,
} from "@ae/config";
import type { HypothesisRow, IdeaMatrix, IdeaScores, ScoreField, Storage } from "@ae/storage";
import { parseCsv } from "./vault.ts";

/**
 * The seeded ideas backlog (brain/ideas/seed-500.csv) → hypotheses.
 *
 * Rule 23: every seeded score is an ESTIMATE. It is shown labelled "estimate", never counts as an outcome,
 * never enters the outcome ledger and is never read by scoring or learning code (static + behavioural
 * tests). `score` and `matrix` are recomputed here from the six scores; the file's own values are only
 * compared, never trusted.
 *
 * Import is idempotent on `id`: a re-import updates text and scores (each score change kept in the
 * history) but never overwrites Archie's decision or comments, nor a stage Archie or an agent changed.
 * A file with any invalid row is rejected whole, with the rows listed; nothing is written.
 */
export const IDEAS_PATH = "brain/ideas/seed-500.csv";

export const IDEA_SCORE_FIELDS: readonly ScoreField[] = [
  "autonomy",
  "speed_to_cash",
  "demand",
  "margin",
  "ease_of_build",
  "low_risk",
];
export const IDEA_COLUMNS = [
  "id",
  "rank",
  "idea",
  "score",
  "matrix",
  "category",
  "buyer",
  "revenue_model",
  "why_now",
  ...IDEA_SCORE_FIELDS,
  "status",
  "decision",
  "comments",
  "batch",
  "score_source",
] as const;

/** Score weights in percent (autonomy 25, speed to cash 20, demand 20, margin 15, ease 10, low risk 10). */
export const IDEA_WEIGHTS: Record<ScoreField, number> = {
  autonomy: 25,
  speed_to_cash: 20,
  demand: 20,
  margin: 15,
  ease_of_build: 10,
  low_risk: 10,
};
export const IDEA_MATRICES: readonly IdeaMatrix[] = ["Do first", "Big bet", "Quick win", "Park"];
export const IDEA_BATCHES = ["1: Market opportunities", "2: Slow processes"] as const;
export const IDEA_DECISIONS = ["Pass", "Fail", "Question"] as const;
export type IdeaDecision = (typeof IDEA_DECISIONS)[number];

/** 0–100. Weighted mean of the 1–5 scores as a share of 5. The weights are multiples of 5, so it's exact. */
export function ideaScore(s: IdeaScores): number {
  const points = IDEA_SCORE_FIELDS.reduce((a, f) => a + IDEA_WEIGHTS[f] * s[f], 0);
  return points / 5;
}

/** Value = mean(demand, margin); feasibility = mean(autonomy, speed to cash, ease of build, low risk); 4+ is high. */
export function ideaMatrix(s: IdeaScores): IdeaMatrix {
  const value = (s.demand + s.margin) / 2 >= 4;
  const feasible = (s.autonomy + s.speed_to_cash + s.ease_of_build + s.low_risk) / 4 >= 4;
  return value ? (feasible ? "Do first" : "Big bet") : feasible ? "Quick win" : "Park";
}

export interface ParsedIdea {
  id: string;
  rank: number;
  idea: string;
  category: string;
  buyer: string;
  revenue_model: string;
  why_now: string;
  batch: string;
  scores: IdeaScores;
  /** Recomputed in code. */
  score: number;
  matrix: IdeaMatrix;
  /** What the file said (compared only). */
  file_score: number;
  file_matrix: string;
  status: "New" | "Built";
  decision: IdeaDecision | null;
  comments: string | null;
  score_source: "estimate";
}

export interface RowProblem {
  /** 1-based data row (the header is row 0). */
  row: number;
  id: string | null;
  problems: string[];
}
export interface IdeasReport {
  ok: boolean;
  rows: ParsedIdea[];
  /** File-level problems (missing columns, empty file). */
  file_problems: string[];
  /** Rows that fail validation: any one rejects the whole file. */
  rejected: RowProblem[];
  /** The file's score or matrix disagrees with the recomputed value. */
  mismatches: { id: string; field: "score" | "matrix"; file: string; computed: string }[];
}

export function validateIdeasSheet(
  text: string,
  cats: IdeaCategoriesConfig = loadIdeaCategoriesConfig(),
): IdeasReport {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  const columns = (header ?? []).map((h) => h.trim());
  const file_problems: string[] = [];
  const missing = IDEA_COLUMNS.filter((c) => !columns.includes(c));
  if (missing.length) file_problems.push(`missing columns: ${missing.join(", ")}`);
  if (body.length === 0) file_problems.push("no data rows");
  if (file_problems.length)
    return { ok: false, rows: [], file_problems, rejected: [], mismatches: [] };

  const col = (r: string[], c: string) => (r[columns.indexOf(c)] ?? "").trim();
  const rows: ParsedIdea[] = [];
  const rejected: RowProblem[] = [];
  const mismatches: IdeasReport["mismatches"] = [];
  const seen = new Map<string, number>();
  body.forEach((r, i) => {
    const n = i + 1;
    const problems: string[] = [];
    const id = col(r, "id");
    if (!/^I\d{3,}$/.test(id)) problems.push(`id "${id}" is not like I001`);
    else if (seen.has(id)) problems.push(`duplicate id ${id} (also row ${seen.get(id)})`);
    else seen.set(id, n);
    const int = (c: string) => (/^-?\d+$/.test(col(r, c)) ? Number(col(r, c)) : Number.NaN);
    const rank = int("rank");
    if (!Number.isInteger(rank) || rank < 1)
      problems.push(`rank "${col(r, "rank")}" is not a positive whole number`);
    const scores = {} as IdeaScores;
    for (const f of IDEA_SCORE_FIELDS) {
      const v = int(f);
      if (!Number.isInteger(v) || v < 1 || v > 5)
        problems.push(`${f} "${col(r, f)}" is outside 1–5`);
      scores[f] = v;
    }
    for (const c of ["idea", "category", "buyer", "revenue_model", "why_now"])
      if (!col(r, c)) problems.push(`${c} is empty`);
    const category = col(r, "category");
    if (category && !cats.categories[category]) problems.push(`unknown category "${category}"`);
    const matrix = col(r, "matrix");
    if (!IDEA_MATRICES.includes(matrix as IdeaMatrix))
      problems.push(`unknown matrix value "${matrix}"`);
    const status = col(r, "status");
    if (status !== "New" && status !== "Built")
      problems.push(`status "${status}" is not New or Built`);
    const batch = col(r, "batch");
    if (!(IDEA_BATCHES as readonly string[]).includes(batch))
      problems.push(`unknown batch "${batch}"`);
    const decision = col(r, "decision");
    if (decision && !(IDEA_DECISIONS as readonly string[]).includes(decision))
      problems.push(`decision "${decision}" is not Pass, Fail or Question`);
    if (col(r, "score_source") !== "estimate")
      problems.push(`score_source "${col(r, "score_source")}" must be "estimate"`);
    const fileScore = int("score");
    if (!Number.isInteger(fileScore))
      problems.push(`score "${col(r, "score")}" is not a whole number`);
    if (problems.length) {
      rejected.push({ row: n, id: id || null, problems });
      return;
    }
    const score = ideaScore(scores);
    const m = ideaMatrix(scores);
    if (score !== fileScore)
      mismatches.push({ id, field: "score", file: String(fileScore), computed: String(score) });
    if (m !== matrix) mismatches.push({ id, field: "matrix", file: matrix, computed: m });
    rows.push({
      id,
      rank,
      idea: col(r, "idea"),
      category,
      buyer: col(r, "buyer"),
      revenue_model: col(r, "revenue_model"),
      why_now: col(r, "why_now"),
      batch,
      scores,
      score,
      matrix: m,
      file_score: fileScore,
      file_matrix: matrix,
      status: status as "New" | "Built",
      decision: (decision || null) as IdeaDecision | null,
      comments: col(r, "comments") || null,
      score_source: "estimate",
    });
  });
  return { ok: rejected.length === 0, rows, file_problems, rejected, mismatches };
}

export class IdeaImportError extends Error {
  constructor(readonly report: IdeasReport) {
    super(
      report.file_problems.length
        ? `ideas file rejected: ${report.file_problems.join("; ")}`
        : `ideas file rejected: ${report.rejected.length} invalid row(s): ${report.rejected
            .slice(0, 10)
            .map((r) => `row ${r.row}${r.id ? ` (${r.id})` : ""}: ${r.problems.join(", ")}`)
            .join("; ")}`,
    );
  }
}

/** Function: the category's taxonomy node, else the per-idea estimate (idea-functions.json), else null. */
export function ideaFunction(
  id: string,
  category: string,
  cats: IdeaCategoriesConfig = loadIdeaCategoriesConfig(),
  fns: IdeaFunctionsConfig = loadIdeaFunctionsConfig(),
): { function: string | null; source: "category" | "estimate" | null } {
  const node = cats.categories[category]?.node;
  if (node) return { function: node, source: "category" };
  const est = fns.ideas[id];
  return est ? { function: est, source: "estimate" } : { function: null, source: null };
}

/** Market: the buyer column, plus the industry where the category names one. */
export function ideaMarket(r: { buyer: string; category: string }) {
  return {
    buyer: r.buyer,
    industry: (INDUSTRY_CATEGORIES as readonly string[]).includes(r.category) ? r.category : null,
  };
}

const stageFor = (status: "New" | "Built") => (status === "Built" ? "live" : "proposed");

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identity of an idea's content: an unchanged failed idea can't be re-raised (Phase 6 uses this). */
export function ideaFingerprint(h: { idea: string } & IdeaScores) {
  return sha256(
    JSON.stringify([h.idea.trim().toLowerCase(), ...IDEA_SCORE_FIELDS.map((f) => h[f])]),
  );
}

export async function ideaReraiseBlocked(h: HypothesisRow, next: { idea: string } & IdeaScores) {
  return h.decision === "Fail" && h.failed_fingerprint === (await ideaFingerprint(next));
}

export interface ImportResult {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  score_changes: number;
  /** Scores Archie or an agent changed that differ from the file: kept, not overwritten. */
  scores_kept: number;
  mismatches: IdeasReport["mismatches"];
  source_hash: string;
}

/** Imports the sheet. Idempotent on id; rejects the whole file if any row is invalid. */
export async function importIdeas(
  storage: Storage,
  text: string,
  o: {
    source?: string;
    by: string;
    categories?: IdeaCategoriesConfig;
    functions?: IdeaFunctionsConfig;
  },
): Promise<ImportResult> {
  const cats = o.categories ?? loadIdeaCategoriesConfig();
  const fns = o.functions ?? loadIdeaFunctionsConfig();
  const report = validateIdeasSheet(text, cats);
  if (!report.ok) throw new IdeaImportError(report);
  const source = o.source ?? IDEAS_PATH;
  const source_hash = await sha256(text);
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let score_changes = 0;
  let scores_kept = 0;
  for (const r of report.rows) {
    const cur = await storage.hypotheses.get(r.id);
    const node = cats.categories[r.category]?.node ?? null;
    const fn = ideaFunction(r.id, r.category, cats, fns);
    const market = ideaMarket(r);
    if (!cur) {
      await storage.hypotheses.put({
        id: r.id,
        rank: r.rank,
        idea: r.idea,
        category: r.category,
        taxonomy_node: node,
        buyer: r.buyer,
        revenue_model: r.revenue_model,
        why_now: r.why_now,
        batch: r.batch,
        ...r.scores,
        score: r.score,
        matrix: r.matrix,
        score_source: "estimate",
        file_status: r.status,
        stage: stageFor(r.status),
        stage_changed_by: null,
        decision: r.decision,
        decision_by: r.decision ? "archie (sheet)" : null,
        decision_at: r.decision ? new Date().toISOString() : null,
        failed_fingerprint:
          r.decision === "Fail" ? await ideaFingerprint({ idea: r.idea, ...r.scores }) : null,
        comments: r.comments,
        function: fn.function,
        function_source: fn.source,
        function_changed_by: null,
        market_buyer: market.buyer,
        market_industry: market.industry,
        synthetic: false,
      });
      for (const f of IDEA_SCORE_FIELDS)
        await storage.hypotheses.addHistory({
          hypothesis_id: r.id,
          field: f,
          old_value: null,
          new_value: r.scores[f],
          changed_by: "import",
          reason: `seeded estimate from ${source}`,
        });
      created++;
      continue;
    }
    // Re-import: new text follows the file. A score Archie or an agent changed since import sticks (the
    // dashboard is the record); untouched scores follow the file. Decisions, comments, a changed stage and
    // a changed function are never overwritten.
    const edited = new Set(
      (await storage.hypotheses.history(r.id))
        .filter((h) => h.changed_by !== "import")
        .map((h) => h.field),
    );
    const scores = {} as IdeaScores;
    for (const f of IDEA_SCORE_FIELDS) scores[f] = edited.has(f) ? cur[f] : r.scores[f];
    scores_kept += IDEA_SCORE_FIELDS.filter((f) => edited.has(f) && cur[f] !== r.scores[f]).length;
    const changedScores = IDEA_SCORE_FIELDS.filter((f) => cur[f] !== scores[f]);
    const next: HypothesisRow = {
      ...cur,
      rank: r.rank,
      idea: r.idea,
      category: r.category,
      taxonomy_node: node,
      buyer: r.buyer,
      revenue_model: r.revenue_model,
      why_now: r.why_now,
      batch: r.batch,
      ...scores,
      score: ideaScore(scores),
      matrix: ideaMatrix(scores),
      file_status: r.status,
      stage: cur.stage_changed_by ? cur.stage : stageFor(r.status),
      decision: cur.decision ?? r.decision,
      decision_by: cur.decision ? cur.decision_by : r.decision ? "archie (sheet)" : null,
      decision_at: cur.decision ? cur.decision_at : r.decision ? new Date().toISOString() : null,
      failed_fingerprint:
        cur.failed_fingerprint ??
        (!cur.decision && r.decision === "Fail"
          ? await ideaFingerprint({ idea: r.idea, ...r.scores })
          : null),
      comments: cur.comments || r.comments,
      function: cur.function_changed_by ? cur.function : fn.function,
      function_source: cur.function_changed_by ? cur.function_source : fn.source,
      market_buyer: market.buyer,
      market_industry: market.industry,
    };
    const keys: (keyof HypothesisRow)[] = [
      "rank",
      "idea",
      "category",
      "taxonomy_node",
      "buyer",
      "revenue_model",
      "why_now",
      "batch",
      ...IDEA_SCORE_FIELDS,
      "file_status",
      "stage",
      "decision",
      "comments",
      "function",
      "function_source",
      "market_buyer",
      "market_industry",
    ];
    if (keys.every((k) => cur[k] === next[k])) {
      unchanged++;
      continue;
    }
    await storage.hypotheses.put(next);
    for (const f of changedScores) {
      await storage.hypotheses.addHistory({
        hypothesis_id: r.id,
        field: f,
        old_value: cur[f],
        new_value: scores[f],
        changed_by: "import",
        reason: `re-import of ${source}`,
      });
      score_changes++;
    }
    updated++;
  }
  await storage.hypotheses.recordImport({
    id: crypto.randomUUID(),
    source,
    source_hash,
    rows: report.rows.length,
    created,
    updated,
    unchanged,
    imported_by: o.by,
  });
  return {
    rows: report.rows.length,
    created,
    updated,
    unchanged,
    score_changes,
    scores_kept,
    mismatches: report.mismatches,
    source_hash,
  };
}

export class IdeaChangeError extends Error {}

/**
 * Archie or an agent changes one score. The new value is still an estimate. Who, when and why go in the
 * history; score and matrix are recomputed.
 */
export async function changeIdeaScore(
  storage: Storage,
  id: string,
  field: ScoreField,
  value: number,
  o: { by: string; reason: string },
): Promise<HypothesisRow> {
  if (!IDEA_SCORE_FIELDS.includes(field)) throw new IdeaChangeError("unknown_score");
  if (!Number.isInteger(value) || value < 1 || value > 5)
    throw new IdeaChangeError("score_outside_1_5");
  if (!o.by.trim()) throw new IdeaChangeError("who_is_required");
  if (!o.reason.trim()) throw new IdeaChangeError("reason_is_required");
  const cur = await storage.hypotheses.get(id);
  if (!cur) throw new IdeaChangeError("not_found");
  if (cur[field] === value) return cur;
  const next = { ...cur, [field]: value } as HypothesisRow;
  next.score = ideaScore(next);
  next.matrix = ideaMatrix(next);
  await storage.hypotheses.put(next);
  await storage.hypotheses.addHistory({
    hypothesis_id: id,
    field,
    old_value: cur[field],
    new_value: value,
    changed_by: o.by,
    reason: o.reason,
  });
  return (await storage.hypotheses.get(id)) as HypothesisRow;
}

/**
 * Records Pass / Fail / Question on an idea. In Phase 6 this is the apply-step of the one decisions path
 * (`decide()`); no route calls it directly. A Fail stores the content fingerprint.
 */
export async function applyIdeaDecision(
  storage: Storage,
  id: string,
  decision: IdeaDecision,
  by: string,
  comment?: string,
): Promise<HypothesisRow> {
  const cur = await storage.hypotheses.get(id);
  if (!cur) throw new IdeaChangeError("not_found");
  await storage.hypotheses.put({
    ...cur,
    decision,
    decision_by: by,
    decision_at: new Date().toISOString(),
    failed_fingerprint: decision === "Fail" ? await ideaFingerprint(cur) : cur.failed_fingerprint,
    comments: comment ?? cur.comments,
  });
  return (await storage.hypotheses.get(id)) as HypothesisRow;
}

/** Archie or an agent moves an idea's stage; a re-import then leaves it alone. */
export async function setIdeaStage(storage: Storage, id: string, stage: string, by: string) {
  const cur = await storage.hypotheses.get(id);
  if (!cur) throw new IdeaChangeError("not_found");
  await storage.hypotheses.put({ ...cur, stage, stage_changed_by: by });
}

/** The Vault's view of the sheet: every row with recomputed values, labelled estimate, linked to its card. */
export function ideasSheetView(text: string, cats = loadIdeaCategoriesConfig()) {
  const r = validateIdeasSheet(text, cats);
  return {
    ok: r.ok,
    file_problems: r.file_problems,
    rejected: r.rejected,
    mismatches: r.mismatches,
    note: "Every score in this sheet is an estimate. It is never treated as an outcome, never enters the outcome ledger and never trains scoring.",
    rows: r.rows.map((x) => ({
      id: x.id,
      rank: x.rank,
      idea: x.idea,
      category: x.category,
      taxonomy_node: cats.categories[x.category]?.node ?? null,
      function: ideaFunction(x.id, x.category, cats).function,
      function_source: ideaFunction(x.id, x.category, cats).source,
      market: ideaMarket(x),
      buyer: x.buyer,
      revenue_model: x.revenue_model,
      why_now: x.why_now,
      batch: x.batch,
      status: x.status,
      decision: x.decision,
      scores: x.scores,
      score: x.score,
      matrix: x.matrix,
      score_source: x.score_source,
      card: `#/ideas/${x.id}`,
    })),
  };
}

/** Archie or an agent sets an idea's function; a re-import then leaves it alone. */
export async function setIdeaFunction(storage: Storage, id: string, fn: string, by: string) {
  const cur = await storage.hypotheses.get(id);
  if (!cur) throw new IdeaChangeError("not_found");
  await storage.hypotheses.put({
    ...cur,
    function: fn,
    function_source: "set",
    function_changed_by: by,
  });
}
